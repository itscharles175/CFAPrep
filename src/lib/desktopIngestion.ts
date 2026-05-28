// Native folder ingestion (Tauri shell only). Lets the user point at a real
// folder of CFA PDFs on disk; we walk it via a Rust command, read each PDF's
// bytes via another Rust command, then extract + chunk + classify + persist
// into the same Dexie source-vault tables the bundled `.qvsource` writes to.
// No bundling, no copying — works offline against whatever the user has.
//
// Mirrors the classification + chunking semantics of scripts/cfa-source-vault.mjs
// so the resulting documents are indistinguishable from the bundled ingestion.

import type { CfaSourceChunk, CfaSourceDocument, CfaSourceLevel } from './cfaSourceTypes';
import { db } from './progressStore';

/** True when we're running inside the Tauri webview (vs plain browser dev). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface PdfEntry {
  path: string;
  name: string;
  size: number;
  /** Forward-slash relative to the user's picked folder; used for classification. */
  relative: string;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Native folder ingestion is only available in the desktop shell.');
  // Dynamic import: pure-browser dev should never load this code path.
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

export async function pickCfaFolder(): Promise<string | null> {
  return tauriInvoke<string | null>('cfa_pick_folder');
}

export async function listFolderPdfs(folder: string): Promise<PdfEntry[]> {
  return tauriInvoke<PdfEntry[]>('cfa_list_pdfs', { folder });
}

export async function readPdfBytes(path: string): Promise<Uint8Array> {
  // Tauri serializes Vec<u8> as a JSON array of numbers across the bridge.
  const raw = await tauriInvoke<number[]>('cfa_read_pdf_bytes', { path });
  return new Uint8Array(raw);
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

const HEADING_PATTERN = /\b(?:LEARNING MODULE|READING|LEARNING OUTCOMES)\b[^.]{0,90}/i;

function headingForSlice(text: string): string | undefined {
  const match = text.match(HEADING_PATTERN);
  return match ? match[0].replace(/\s+/g, ' ').trim().slice(0, 90) : undefined;
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
      chunks.push({
        id: `${documentId}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
        documentId,
        chunkIndex: chunks.length,
        locator: startPage === endPage ? `p. ${startPage}` : `p. ${startPage}-${endPage}`,
        heading: headingForSlice(chunkText),
        text: chunkText,
        normalizedText: normalizedChunk,
        topicIds,
        sourceHash: hash,
        importedAt,
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

export async function extractPdfPages(bytes: Uint8Array): Promise<{ pages: PageText[]; numPages: number; charCount: number }> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
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
      await db.transaction('rw', db.sourceDocuments, db.sourceChunks, async () => {
        await db.sourceDocuments.put(document);
        await db.sourceChunks.bulkPut(chunks);
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
