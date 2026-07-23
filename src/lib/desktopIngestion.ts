// Native folder ingestion (Electron shell only). Lets the user point at a real
// folder of CFA PDFs on disk; the constrained preload lists and reads them,
// then this renderer extracts + chunks + classifies + persists the content
// into the same Dexie source-vault tables the bundled `.qvsource` writes to.
// No bundling, no copying — works offline against whatever the user has.
//
// Mirrors the classification + chunking semantics of scripts/cfa-source-vault.mjs
// so the resulting documents are indistinguishable from the bundled ingestion.

import type { CfaSourceChunk, CfaSourceDocument, CfaSourceLevel } from './cfaSourceTypes';
import {
  getDesktopBridge,
  isElectronRuntime,
  registerDesktopSubscription,
  type DesktopUnsubscribe,
} from './desktopBridge';
import { db } from './progressStore';
import { encryptSourceChunksForStorage } from './sourceChunkSecureVault';

export function isElectron(): boolean {
  return isElectronRuntime();
}

export interface PdfEntry {
  path: string;
  name: string;
  size: number;
  /** Forward-slash relative to the user's picked folder; used for classification. */
  relative: string;
}

function requireDesktopFiles() {
  const files = getDesktopBridge()?.files;
  if (!files) throw new Error('Native folder ingestion is only available in the desktop shell.');
  return files;
}

export async function pickCfaFolder(): Promise<string | null> {
  return requireDesktopFiles().pickFolder();
}

export async function listFolderPdfs(folder: string): Promise<PdfEntry[]> {
  const entries = await requireDesktopFiles().listPdfs(folder);
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    size: entry.size,
    relative: entry.relative_path,
  }));
}

export async function readPdfBytes(path: string): Promise<Uint8Array> {
  const result = await requireDesktopFiles().read(path);
  return new Uint8Array(result.data);
}

type PdfDropSubscription = DesktopUnsubscribe & {
  then(onRegistered: (unsubscribe: DesktopUnsubscribe) => void): Promise<void>;
};

/** Keep the current JS consumer's `.then(...)` path while cleanup is now synchronous. */
function withLegacyAsyncSubscription(unsubscribe: DesktopUnsubscribe): PdfDropSubscription {
  return Object.assign(unsubscribe, {
    then(onRegistered: (registered: DesktopUnsubscribe) => void): Promise<void> {
      return Promise.resolve().then(() => onRegistered(unsubscribe));
    },
  });
}

/**
 * Subscribe to the Electron window's drag-drop event for PDF files. The handler
 * is called once per drop with the absolute paths the user dropped, filtered
 * to .pdf files. Returns an unlisten function (call it on unmount).
 *
 * No-op in plain web dev; returns cleanup synchronously. The thenable facet keeps
 * the existing unowned JS caller compatible while it migrates to sync cleanup.
 */
export function onElectronPdfDrop(handler: (paths: string[]) => void): PdfDropSubscription {
  const bridge = getDesktopBridge();
  if (!bridge) return withLegacyAsyncSubscription(() => undefined);

  const unsubscribe = registerDesktopSubscription(() =>
    bridge.events.onPdfDrop((event) => {
      const paths = event.paths.filter((path) => /\.pdf$/i.test(path));
      if (paths.length > 0) handler(paths);
    }),
  );
  return withLegacyAsyncSubscription(unsubscribe);
}

/**
 * Ingest an explicit list of PDF file paths (skips the folder-listing step
 * that `ingestFolder` would do). Used by the drag-drop path.
 */
export async function ingestPdfPaths(params: {
  paths: string[];
  onProgress?: (event: IngestionProgress) => void;
  signal?: AbortSignal;
}): Promise<IngestionResult> {
  const { paths, onProgress, signal } = params;
  const result: IngestionResult = {
    folder: '',
    scanned: paths.length,
    ingested: 0,
    skipped: 0,
    chunkCount: 0,
    warnings: [],
  };

  const existingHashes = new Set<string>();
  const existingDocs = await db.sourceDocuments.toArray();
  for (const doc of existingDocs) existingHashes.add(doc.sha256);

  for (let index = 0; index < paths.length; index += 1) {
    if (signal?.aborted) break;
    const path = paths[index];
    const name = path.split(/[\\/]/).pop() || path;
    onProgress?.({ index, total: paths.length, fileName: name, status: 'reading' });
    try {
      const bytes = await readPdfBytes(path);
      const hash = await sha256Hex(bytes);
      if (existingHashes.has(hash)) {
        result.skipped += 1;
        onProgress?.({ index, total: paths.length, fileName: name, status: 'skipped', message: 'already ingested' });
        continue;
      }
      onProgress?.({ index, total: paths.length, fileName: name, status: 'extracting' });
      const extracted = await extractPdfPages(bytes);
      const importedAt = new Date().toISOString();
      const classification = classifyPath(name);
      const documentId = `desktop:${hash.slice(0, 16)}`;
      const chunks = pageChunksFromPages(extracted.pages, documentId, hash, classification.topicIds, importedAt);

      const document: CfaSourceDocument = {
        id: documentId,
        title: classification.title,
        level: classification.level,
        year: classification.year,
        publisher: classification.publisher,
        sourceKind: classification.sourceKind,
        format: 'pdf',
        path,
        sha256: hash,
        sizeBytes: bytes.byteLength,
        pageCount: extracted.numPages,
        extractableTextChars: extracted.charCount,
        canonical: classification.sourceKind === 'official-curriculum',
        coverageTags: classification.coverageTags,
        topicIds: classification.topicIds,
        chunkCount: chunks.length,
        importedAt,
        privateUseOnly: true,
      };

      onProgress?.({ index, total: paths.length, fileName: name, status: 'storing' });
      const chunksForStorage = await encryptSourceChunksForStorage(chunks);
      await db.transaction('rw', db.sourceDocuments, db.sourceChunks, async () => {
        await db.sourceDocuments.put(document);
        await db.sourceChunks.bulkPut(chunksForStorage);
      });
      existingHashes.add(hash);
      result.ingested += 1;
      result.chunkCount += chunks.length;
      onProgress?.({ index, total: paths.length, fileName: name, status: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`${name}: ${message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Classification — mirrors classifyPath() in scripts/cfa-source-vault.mjs so
// desktop-ingested documents land with the same level/topicIds the bundled
// pipeline would have assigned.
// ---------------------------------------------------------------------------

const TOPIC_RULES: [string, RegExp][] = [
  ['ethics', /ethic|professional standards|gips/i],
  ['quant-methods', /quant|statistic|probability|regression|machine learning|time value/i],
  ['economics', /economics|currency|macro|micro|growth|exchange/i],
  ['fsa', /financial statement|reporting|accounting|fsa/i],
  ['corporate', /corporate|issuer|capital structure|governance/i],
  ['equity', /equity|valuation|asset valuation/i],
  ['fixed-income', /fixed income|bond|credit|duration|yield/i],
  ['derivatives', /derivative|option|future|forward|swap/i],
  ['alternatives', /alternative|private equity|real estate|commodity|hedge/i],
  ['portfolio', /portfolio|wealth planning|risk management/i],
  ['asset-allocation', /asset allocation|capital market expectation/i],
  ['portfolio-construction', /portfolio construction|manager selection|implementation/i],
  ['performance', /performance|attribution|benchmark/i],
  ['derivatives-risk', /derivatives and risk|currency management|overlay/i],
  ['pm-pathway', /portfolio management pathway|active equity|index design|trade strategy/i],
  ['private-markets-pathway', /private markets|general partner|private credit|infrastructure/i],
  ['private-wealth-pathway', /private wealth|family|tax|wealth transfer|ultra-high/i],
];

export interface PathClassification {
  title: string;
  level: CfaSourceLevel;
  sourceKind: CfaSourceDocument['sourceKind'];
  publisher: string;
  year?: number;
  topicIds: string[];
  coverageTags: string[];
}

export function classifyPath(filePath: string): PathClassification {
  const normalized = filePath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const ext = (filePath.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const base = filePath.split(/[\\/]/).pop() || filePath;
  const title = base
    .slice(0, base.length - ext.length)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const levelHint = `${lower} ${title.toLowerCase()}`;
  const level: CfaSourceLevel = /\blevel\s*(?:1|i)\b(?!i)/.test(levelHint)
    ? 'level1'
    : /\blevel\s*(?:2|ii)\b(?!i)/.test(levelHint)
      ? 'level2'
      : /\blevel\s*(?:3|iii)\b/.test(levelHint)
        ? 'level3'
        : lower.includes('/prerequisites/')
          ? 'prerequisite'
          : lower.includes('/reference books/')
            ? 'reference'
            : 'unknown';
  const sourceKind: CfaSourceDocument['sourceKind'] = /official curriculum|program curriculum/.test(levelHint)
    ? 'official-curriculum'
    : lower.includes('schweser') || lower.includes('wiley')
      ? 'prep-provider'
      : lower.includes('reference books')
        ? 'reference-book'
        : 'user-source';
  const publisher = lower.includes('schweser')
    ? 'Schweser'
    : lower.includes('wiley')
      ? 'Wiley'
      : /official curriculum|program curriculum|cfa institute/.test(levelHint)
        ? 'CFA Institute'
        : lower.includes('reference books')
          ? 'Reference Books'
          : 'User Source';
  const yearMatch = lower.match(/\/(20\d\d)\//);
  const topicIds = TOPIC_RULES.filter(([, pattern]) => pattern.test(title)).map(([id]) => id);
  const coverageTags = [level, sourceKind, publisher.toLowerCase().replace(/[^a-z0-9]+/g, '-')].filter(Boolean);
  return {
    title,
    level,
    sourceKind,
    publisher,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    topicIds,
    coverageTags,
  };
}

// ---------------------------------------------------------------------------
// Page-aware chunker — mirrors pageChunksFromPages() in the Node script.
// ---------------------------------------------------------------------------

export interface PageText {
  pageNumber: number;
  text: string;
}

// Section headings in CFA curriculum text. The original variants ("LEARNING
// MODULE", "READING", "LEARNING OUTCOMES") match case-insensitively anywhere.
// The broadened variants ("STUDY SESSION", "TOPIC", "MODULE n") are scoped to
// an ALL-CAPS run so we don't match the words "topic" / "module" / "reading"
// when they appear mid-sentence in ordinary prose. A trailing letter-bearing
// label (number, colon, or title text) is required so a bare capitalized word
// in a sentence ("The READING was long.") doesn't qualify.
const HEADING_PATTERN =
  /\b(?:LEARNING MODULE|READING|LEARNING OUTCOMES|STUDY SESSION|TOPIC|MODULE)\b(?:\s+\d+)?(?:[ :.–-][^.]{0,90})?/;

function headingForSlice(text: string): string | undefined {
  const match = text.match(HEADING_PATTERN);
  if (!match) return undefined;
  return match[0].replace(/\s+/g, ' ').trim().slice(0, 90);
}

// ---------------------------------------------------------------------------
// LOS (Learning Outcome Statement) extraction. CFA LOS are highly patterned:
// a "The candidate should be able to:" / "Learning Outcomes" lead-in followed
// by a lettered or bulleted list, each item opening with one of a fixed set of
// command verbs. We exploit that structure to pull out individual statements.
// ---------------------------------------------------------------------------

export interface ExtractedStructure {
  heading?: string; // best section heading found (existing behavior, kept)
  learningOutcomes: string[]; // individual LOS statements detected in the text
  losVerbs: string[]; // the action verbs that opened each LOS (calculate, describe, …)
}

// The CFA LOS command-word set. Order doesn't matter; it's joined into an
// alternation. Verbs are matched case-insensitively at the start of a statement.
const LOS_COMMAND_VERBS = [
  'calculate',
  'describe',
  'explain',
  'compare',
  'contrast',
  'demonstrate',
  'determine',
  'evaluate',
  'identify',
  'interpret',
  'analyze',
  'estimate',
  'formulate',
  'justify',
  'recommend',
  'distinguish',
  'define',
  'derive',
  'construct',
  'classify',
  'prepare',
] as const;

const LOS_VERB_ALTERNATION = LOS_COMMAND_VERBS.join('|');

// A LOS line: optional list marker (a. / b) / • / - / digit.) then a command
// verb then the rest of the statement up to a terminating ; or . or newline or
// the next list marker. The verb is captured in group 1.
const LOS_LINE_PATTERN = new RegExp(
  String.raw`(?:^|[;\n••\-–]|\b[a-z]\.|\b[a-z]\)|\b\d{1,2}\.)\s*(` + LOS_VERB_ALTERNATION + String.raw`)\b[^;.\n••]*`,
  'gi',
);

// Lead-in phrases that introduce a LOS section. We only mine for LOS once we've
// seen one of these, which guards against random sentences that happen to begin
// with a command verb (e.g. "Describe the chart below.").
const LOS_LEADIN_PATTERN = /(?:the candidate should be able to|learning outcomes?|learning outcome statements?)\s*:?/i;

const MAX_LOS = 20;
const MAX_LOS_LENGTH = 200;

export function extractStructure(text: string): ExtractedStructure {
  const heading = headingForSlice(text);
  const learningOutcomes: string[] = [];
  const verbSet = new Set<string>();

  const leadIn = text.match(LOS_LEADIN_PATTERN);
  if (leadIn && typeof leadIn.index === 'number') {
    // Only scan the region after the lead-in phrase so unrelated command-verb
    // sentences earlier in the chunk aren't swept up as outcomes.
    const region = text.slice(leadIn.index + leadIn[0].length);
    const pattern = new RegExp(LOS_LINE_PATTERN.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(region)) !== null) {
      if (match[0].trim().length === 0) {
        // Zero-width safety: advance to avoid an infinite loop.
        pattern.lastIndex += 1;
        continue;
      }
      const verb = match[1].toLowerCase();
      const statement = match[0]
        .replace(/^[\s;••\-–]*(?:[a-z][.)]|\d{1,2}\.)?\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_LOS_LENGTH);
      if (!statement) continue;
      learningOutcomes.push(statement);
      verbSet.add(verb);
      if (learningOutcomes.length >= MAX_LOS) break;
    }
  }

  return {
    heading,
    learningOutcomes,
    losVerbs: [...verbSet],
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
}

export function pageChunksFromPages(
  pages: PageText[],
  documentId: string,
  hash: string,
  topicIds: string[],
  importedAt: string,
  { wordsPerChunk = 480, overlap = 60 }: { wordsPerChunk?: number; overlap?: number } = {},
): CfaSourceChunk[] {
  const words: { word: string; page: number }[] = [];
  for (const page of pages) {
    if (!page.text) continue;
    for (const word of page.text.split(/\s+/)) {
      if (word) words.push({ word, page: page.pageNumber });
    }
  }
  const chunks: CfaSourceChunk[] = [];
  const step = Math.max(1, wordsPerChunk - overlap);
  for (let index = 0; index < words.length; index += step) {
    const slice = words.slice(index, index + wordsPerChunk);
    if (!slice.length) break;
    const chunkText = slice.map((entry) => entry.word).join(' ');
    const normalizedChunk = normalizeText(chunkText);
    if (normalizedChunk.length >= 80) {
      const startPage = slice[0].page;
      const endPage = slice[slice.length - 1].page;
      const structure = extractStructure(chunkText);
      chunks.push({
        id: `${documentId}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
        documentId,
        chunkIndex: chunks.length,
        locator: startPage === endPage ? `p. ${startPage}` : `p. ${startPage}-${endPage}`,
        heading: structure.heading,
        text: chunkText,
        normalizedText: normalizedChunk,
        topicIds,
        sourceHash: hash,
        importedAt,
        ...(structure.learningOutcomes.length ? { learningOutcomes: structure.learningOutcomes } : {}),
        ...(structure.losVerbs.length ? { losVerbs: structure.losVerbs } : {}),
      });
    }
    if (index + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Browser PDF extraction (lazy-loaded so the dep doesn't bloat initial bundle).
// ---------------------------------------------------------------------------

interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (config: unknown) => { promise: Promise<PdfDocument> };
}

interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy?: () => Promise<void> | void;
}

interface PdfPage {
  getTextContent: () => Promise<{ items: { str?: string }[] }>;
  cleanup?: () => void;
}

let pdfjsCached: PdfJsLib | null = null;
async function loadPdfjs(): Promise<PdfJsLib> {
  if (pdfjsCached) return pdfjsCached;
  const lib = (await import('pdfjs-dist')) as unknown as PdfJsLib;
  if (!lib.GlobalWorkerOptions.workerSrc) {
    // Vite resolves `?url` to a hashed asset URL at build time. The workerSrc
    // must be a real URL the browser can fetch.
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')) as { default: string };
    lib.GlobalWorkerOptions.workerSrc = workerUrl.default;
  }
  pdfjsCached = lib;
  return lib;
}

export async function extractPdfPages(
  bytes: Uint8Array,
): Promise<{ pages: PageText[]; numPages: number; charCount: number }> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false, verbosity: 0 })
    .promise;
  const pages: PageText[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ pageNumber, text });
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }
  return { pages, numPages: doc.numPages, charCount: pages.reduce((sum, page) => sum + page.text.length, 0) };
}

// ---------------------------------------------------------------------------
// SHA-256 via Web Crypto — used both for dedupe and the documentId derivation.
// ---------------------------------------------------------------------------

/**
 * Ingest a free-text source (paste, clipboard, lecture transcript). Creates a
 * sourceDocument + page-aware chunks indistinguishable from the bundled or
 * desktop-PDF pipeline so all downstream features (RAG, source-vault search,
 * citation legend) work uniformly. Skips silently if the same text was already
 * ingested (sha256 dedupe).
 */
export async function ingestTextSource(params: {
  title: string;
  text: string;
  topicIds?: string[];
  level?: CfaSourceLevel;
  publisher?: string;
}): Promise<{ documentId: string; chunkCount: number; deduped: boolean }> {
  const text = (params.text || '').trim();
  if (!text) throw new Error('Pasted text is empty.');
  const title = (params.title || 'Pasted source').trim();
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const hash = await sha256Hex(bytes);
  const documentId = `paste:${hash.slice(0, 16)}`;

  const existing = await db.sourceDocuments.get(documentId);
  if (existing) return { documentId, chunkCount: existing.chunkCount ?? 0, deduped: true };

  const importedAt = new Date().toISOString();
  // Synthesize one "page" so the chunker's locator code yields p.1 references.
  const chunks = pageChunksFromPages([{ pageNumber: 1, text }], documentId, hash, params.topicIds || [], importedAt);
  const document: CfaSourceDocument = {
    id: documentId,
    title,
    level: params.level || 'unknown',
    publisher: params.publisher || 'User Paste',
    sourceKind: 'user-source',
    format: 'text',
    sha256: hash,
    sizeBytes: bytes.byteLength,
    pageCount: 1,
    extractableTextChars: text.length,
    canonical: false,
    coverageTags: [params.level || 'unknown', 'user-source'],
    topicIds: params.topicIds || [],
    chunkCount: chunks.length,
    importedAt,
    privateUseOnly: true,
  };
  const chunksForStorage = await encryptSourceChunksForStorage(chunks);
  await db.transaction('rw', db.sourceDocuments, db.sourceChunks, async () => {
    await db.sourceDocuments.put(document);
    await db.sourceChunks.bulkPut(chunksForStorage);
  });
  return { documentId, chunkCount: chunks.length, deduped: false };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast through ArrayBufferView so TS accepts it as a BufferSource regardless
  // of whether the underlying buffer is ArrayBuffer or SharedArrayBuffer.
  const buffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Orchestrator: pick → list → ingest each PDF → persist.
// ---------------------------------------------------------------------------

export interface IngestionProgress {
  index: number;
  total: number;
  fileName: string;
  status: 'reading' | 'extracting' | 'storing' | 'skipped' | 'done';
  message?: string;
}

export interface IngestionResult {
  folder: string;
  scanned: number;
  ingested: number;
  skipped: number;
  chunkCount: number;
  warnings: string[];
}

/**
 * Ingest every PDF under a folder into the source vault. Dedupes by sha256 so
 * re-running on the same folder is a no-op (and re-running after adding new
 * volumes only ingests the new ones).
 */
export async function ingestFolder(params: {
  folder: string;
  onProgress?: (event: IngestionProgress) => void;
  signal?: AbortSignal;
}): Promise<IngestionResult> {
  const { folder, onProgress, signal } = params;
  const pdfs = await listFolderPdfs(folder);
  const result: IngestionResult = {
    folder,
    scanned: pdfs.length,
    ingested: 0,
    skipped: 0,
    chunkCount: 0,
    warnings: [],
  };

  const existingHashes = new Set<string>();
  const existingDocs = await db.sourceDocuments.toArray();
  for (const doc of existingDocs) existingHashes.add(doc.sha256);

  for (let index = 0; index < pdfs.length; index += 1) {
    if (signal?.aborted) break;
    const pdf = pdfs[index];
    onProgress?.({ index, total: pdfs.length, fileName: pdf.name, status: 'reading' });
    try {
      const bytes = await readPdfBytes(pdf.path);
      const hash = await sha256Hex(bytes);
      if (existingHashes.has(hash)) {
        result.skipped += 1;
        onProgress?.({ index, total: pdfs.length, fileName: pdf.name, status: 'skipped', message: 'already ingested' });
        continue;
      }
      onProgress?.({ index, total: pdfs.length, fileName: pdf.name, status: 'extracting' });
      const extracted = await extractPdfPages(bytes);
      const importedAt = new Date().toISOString();
      const classification = classifyPath(pdf.relative || pdf.name);
      const documentId = `desktop:${hash.slice(0, 16)}`;
      const chunks = pageChunksFromPages(extracted.pages, documentId, hash, classification.topicIds, importedAt);

      const document: CfaSourceDocument = {
        id: documentId,
        title: classification.title,
        level: classification.level,
        year: classification.year,
        publisher: classification.publisher,
        sourceKind: classification.sourceKind,
        format: 'pdf',
        path: pdf.path,
        sha256: hash,
        sizeBytes: pdf.size,
        pageCount: extracted.numPages,
        extractableTextChars: extracted.charCount,
        canonical: classification.sourceKind === 'official-curriculum',
        coverageTags: classification.coverageTags,
        topicIds: classification.topicIds,
        chunkCount: chunks.length,
        importedAt,
        privateUseOnly: true,
      };

      onProgress?.({ index, total: pdfs.length, fileName: pdf.name, status: 'storing' });
      const chunksForStorage = await encryptSourceChunksForStorage(chunks);
      await db.transaction('rw', db.sourceDocuments, db.sourceChunks, async () => {
        await db.sourceDocuments.put(document);
        await db.sourceChunks.bulkPut(chunksForStorage);
      });
      existingHashes.add(hash);
      result.ingested += 1;
      result.chunkCount += chunks.length;
      onProgress?.({ index, total: pdfs.length, fileName: pdf.name, status: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`${pdf.relative || pdf.name}: ${message}`);
    }
  }
  return result;
}
