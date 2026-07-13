import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const DEFAULT_ROOT = 'C:\\Users\\charl\\Downloads\\Compressed';
const REPORT_DIR = resolve('dist/reports');
const execFileAsync = promisify(execFile);
const DEFAULT_PRIVATE_DIR =
  process.env.QV_SOURCE_VAULT_DIR ||
  (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuantVault', 'source-vault')
    : join(homedir(), '.quantvault', 'source-vault'));
const PRIVATE_DIR = resolve(DEFAULT_PRIVATE_DIR);
const LATEST_BUNDLE = join(PRIVATE_DIR, 'latest.qvsource');
const SOURCE_POLICY = {
  privateUseOnly: true,
  allowStandardExport: false,
  textStorage: 'local-app-data',
  notes:
    'Full source text is for private local study only and is never written into src, docs, public, dist, release reports, or CI artifacts.',
};

const TOPIC_RULES = [
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
  ['performance', /performance|attribution|benchmark|gips/i],
  ['derivatives-risk', /derivatives and risk|currency management|overlay|hedge/i],
  ['pm-pathway', /portfolio management pathway|active equity|index design|trade strategy/i],
  ['private-markets-pathway', /private markets|general partner|private credit|infrastructure/i],
  ['private-wealth-pathway', /private wealth|family|tax|wealth transfer|ultra-high/i],
];

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const next = rest[index + 1];
      if (!next || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        index += 1;
      }
    }
  }
  return options;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9.%$]+/g, ' ')
    .trim();
}

function visibleText(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath, ext).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Match level from the full path AND the title, tolerant of "Level 1", "Level I",
  // and folder names like "CFA Level 1/" (no leading slash before "level").
  const levelHint = `${lower} ${title.toLowerCase()}`;
  const level = /\blevel\s*(?:1|i)\b(?!i)/.test(levelHint)
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
  const sourceKind = /official curriculum|program curriculum/.test(levelHint)
    ? 'official-curriculum'
    : lower.includes('schweser') || lower.includes('wiley')
      ? 'prep-provider'
      : lower.includes('reference books')
        ? 'reference-book'
        : lower.includes('_archive_metadata')
          ? 'archive-metadata'
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
  const year = lower.match(/\/(20\d\d)\//)?.[1];
  const format =
    ext === '.pdf'
      ? 'pdf'
      : ext === '.epub'
        ? 'epub'
        : ext === '.html' || ext === '.htm'
          ? 'html'
          : ext === '.xml'
            ? 'xml'
            : ext === '.zip' || ext === '.gz' || ext === '.zst'
              ? 'archive'
              : ext === '.txt'
                ? 'text'
                : 'unknown';
  const topicIds = TOPIC_RULES.filter(([, pattern]) => pattern.test(title)).map(([id]) => id);
  return {
    title,
    level,
    sourceKind,
    publisher,
    year: year ? Number(year) : undefined,
    format,
    topicIds,
    coverageTags: [level, sourceKind, publisher.toLowerCase().replace(/[^a-z0-9]+/g, '-')].filter(Boolean),
  };
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) out.push(fullPath);
    }
  }
  await visit(root);
  return out;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function isSafeZipEntryName(name) {
  const normalized = name.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.endsWith('/'))
    return false;
  return normalized.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset < 0) return [];
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (isSafeZipEntryName(name)) {
      const data = compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
      entries.push({ name, data });
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function textChunksFromText(text, documentId, hash, topicIds, importedAt) {
  const cleanText = visibleText(text);
  const normalized = normalizeText(cleanText);
  if (!normalized) return [];
  const words = cleanText.split(/\s+/);
  const chunks = [];
  for (let index = 0; index < words.length; index += 420) {
    const chunkText = words.slice(index, index + 520).join(' ');
    const normalizedChunk = normalizeText(chunkText);
    if (normalizedChunk.length < 80) continue;
    chunks.push({
      id: `${documentId}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
      documentId,
      chunkIndex: chunks.length,
      locator: `chunk ${chunks.length + 1}`,
      text: chunkText,
      normalizedText: normalizedChunk,
      topicIds,
      sourceHash: hash,
      importedAt,
    });
  }
  return chunks;
}

function extractEpubText(buffer) {
  return readZipEntries(buffer)
    .filter((entry) => /\.(xhtml|html|htm|ncx|opf)$/i.test(entry.name))
    .map((entry) => entry.data.toString('utf8'))
    .join('\n\n');
}

function decodePdfLiteralString(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      output += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) continue;
    index += 1;
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b') output += '\b';
    else if (next === 'f') output += '\f';
    else if (next === '\r' || next === '\n') {
      if (next === '\r' && value[index + 1] === '\n') index += 1;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let lookahead = 0; lookahead < 2 && /[0-7]/.test(value[index + 1] || ''); lookahead += 1) {
        octal += value[index + 1];
        index += 1;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else output += next;
  }
  return output;
}

function extractPdfTextFromStream(streamText) {
  const textBlocks = streamText.match(/\bBT\b[\s\S]*?\bET\b/g) || [];
  const strings = [];
  textBlocks.forEach((block) => {
    const literalPattern = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|"|TJ)?/g;
    let match;
    while ((match = literalPattern.exec(block))) {
      strings.push(decodePdfLiteralString(match[1]));
    }
  });
  return strings.join(' ');
}

function extractPdfText(buffer) {
  const latin = buffer.toString('latin1');
  const streamPattern = /(?:<<[\s\S]*?>>\s*)?stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  const texts = [];
  let match;
  while ((match = streamPattern.exec(latin))) {
    const headerStart = Math.max(0, latin.lastIndexOf('<<', match.index));
    const headerEnd = latin.indexOf('>>', headerStart);
    const header = headerEnd >= 0 && headerEnd < match.index ? latin.slice(headerStart, headerEnd + 2) : '';
    const streamBytes = Buffer.from(match[1], 'latin1');
    let streamText = streamBytes.toString('latin1');
    if (/\/FlateDecode\b/i.test(header)) {
      try {
        streamText = inflateSync(streamBytes).toString('latin1');
      } catch {
        streamText = '';
      }
    }
    const text = extractPdfTextFromStream(streamText);
    if (text) texts.push(text);
  }
  if (!texts.length) {
    const inlineText = extractPdfTextFromStream(latin);
    if (inlineText) texts.push(inlineText);
  }
  return texts.join('\n\n');
}

function extractPlainText(format, buffer) {
  if (format === 'epub') return extractEpubText(buffer);
  if (format === 'pdf') return extractPdfText(buffer);
  if (format === 'html' || format === 'xml' || format === 'text') return buffer.toString('utf8');
  return '';
}

// Real PDF text extraction via pdfjs-dist (the legacy regex extractPdfText above is kept
// only as a fallback and for the synthetic unit tests). Returns per-page text so chunks
// can carry a meaningful page locator.
async function extractPdfPagesWithPdfjs(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
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

const HEADING_PATTERN = /\b(?:LEARNING MODULE|READING|LEARNING OUTCOMES)\b[^.]{0,90}/i;

function headingForSlice(text) {
  const match = text.match(HEADING_PATTERN);
  return match ? match[0].replace(/\s+/g, ' ').trim().slice(0, 90) : undefined;
}

// Page-aware chunker for the pdfjs path. Keeps the same chunk id/index shape as
// textChunksFromText but adds a page-range locator and a best-effort heading.
function pageChunksFromPages(pages, documentId, hash, topicIds, importedAt, { wordsPerChunk = 480, overlap = 60 } = {}) {
  const words = [];
  for (const page of pages) {
    if (!page.text) continue;
    for (const word of page.text.split(/\s+/)) {
      if (word) words.push({ word, page: page.pageNumber });
    }
  }
  const chunks = [];
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

function probePdfQuality(buffer, canonical = false) {
  const latin = buffer.toString('latin1');
  const pageCount = (latin.match(/\/Type\s*\/Page\b/g) || []).length;
  const textOperatorCount = (latin.match(/\bBT\b/g) || []).length;
  const extractableTextChars = normalizeText(extractPdfText(buffer)).length;
  return {
    pageCount,
    textOperatorCount,
    extractableTextChars,
    needsOcr: Boolean(canonical && pageCount > 0 && (textOperatorCount === 0 || extractableTextChars === 0)),
  };
}

function canonicalKey(filePath) {
  const parsed = classifyPath(filePath);
  return `${parsed.level}:${parsed.year || 'na'}:${parsed.publisher}:${parsed.title.toLowerCase().replace(/\bvolume 0(\d)\b/g, 'volume $1')}`;
}

function pickCanonical(files) {
  const byKey = new Map();
  files.forEach((file) => {
    const key = canonicalKey(file);
    const ext = extname(file).toLowerCase();
    const score = ext === '.epub' ? 3 : ext === '.pdf' ? 2 : 1;
    const prior = byKey.get(key);
    if (
      !prior ||
      score > prior.score ||
      (score === prior.score && basename(file).localeCompare(basename(prior.file)) > 0)
    ) {
      byKey.set(key, { file, score });
    }
  });
  return new Set([...byKey.values()].map((row) => row.file));
}

async function commandInventory(root) {
  const files = await walk(root);
  const rows = files.map((file) => {
    const parsed = classifyPath(file);
    return { ...parsed, extension: extname(file).toLowerCase() || '<none>' };
  });
  const grouped = rows.reduce((map, row) => {
    const key = `${row.level}|${row.year || 'n/a'}|${row.publisher}|${row.format}`;
    const current = map.get(key) || {
      level: row.level,
      year: row.year || 'n/a',
      publisher: row.publisher,
      format: row.format,
      files: 0,
    };
    current.files += 1;
    map.set(key, current);
    return map;
  }, new Map());
  await mkdir(REPORT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    root: '<private-local-source-root>',
    files: files.length,
    groups: [...grouped.values()],
  };
  await writeFile(join(REPORT_DIR, 'cfa-source-inventory.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Inventory complete: ${files.length} files. Wrote dist/reports/cfa-source-inventory.json`);
}

async function commandIngest(root, options) {
  const startedAt = new Date().toISOString();
  const allFiles = await walk(root);
  const relevant = allFiles.filter((file) => {
    const lower = file.toLowerCase();
    if (!options.includeArchives && lower.includes('_archive_metadata')) return false;
    if (
      lower.includes('\\ais data\\') ||
      lower.includes('/ais data/') ||
      lower.includes('\\project archives\\') ||
      lower.includes('/project archives/')
    )
      return false;
    return ['.epub', '.pdf', '.html', '.htm', '.xml', '.txt'].includes(extname(file).toLowerCase());
  });
  const canonicalFiles = pickCanonical(relevant);
  const documents = [];
  const chunks = [];
  let bytesScanned = 0;
  for (const file of relevant) {
    const buffer = await readFile(file);
    bytesScanned += buffer.length;
    const parsed = classifyPath(file);
    const hash = sha256(buffer);
    const id = `source:${hash.slice(0, 16)}`;
    const canonical = canonicalFiles.has(file);
    let text = '';
    let docChunks = [];
    let pageCount;
    let extractableTextChars;
    if (canonical) {
      if (parsed.format === 'pdf') {
        try {
          const extracted = await extractPdfPagesWithPdfjs(buffer);
          pageCount = extracted.numPages;
          extractableTextChars = extracted.charCount;
          text = extracted.pages.map((page) => page.text).join('\n\n');
          docChunks = pageChunksFromPages(extracted.pages, id, hash, parsed.topicIds, startedAt);
        } catch (error) {
          console.warn(`pdfjs extraction failed for "${parsed.title}": ${error instanceof Error ? error.message : String(error)}; using fallback parser.`);
        }
        if (!docChunks.length) {
          const fallback = probePdfQuality(buffer, canonical);
          text = text || extractPdfText(buffer);
          docChunks = textChunksFromText(text, id, hash, parsed.topicIds, startedAt);
          pageCount = pageCount ?? fallback.pageCount;
          extractableTextChars = extractableTextChars ?? fallback.extractableTextChars;
        }
      } else {
        text = extractPlainText(parsed.format, buffer);
        docChunks = textChunksFromText(text, id, hash, parsed.topicIds, startedAt);
      }
    }
    const needsOcr = Boolean(canonical && parsed.format === 'pdf' && docChunks.length === 0);
    chunks.push(...docChunks);
    documents.push({
      id,
      title: parsed.title,
      level: parsed.level,
      year: parsed.year,
      publisher: parsed.publisher,
      sourceKind: parsed.sourceKind,
      format: parsed.format,
      path: relative(root, file).replaceAll('\\', '/'),
      sha256: hash,
      logicalHash: text ? sha256(Buffer.from(normalizeText(text))) : undefined,
      sizeBytes: buffer.length,
      pageCount,
      extractableTextChars,
      spineCount:
        parsed.format === 'epub'
          ? readZipEntries(buffer).filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.name)).length
          : undefined,
      canonical,
      needsOcr,
      coverageTags: parsed.coverageTags,
      topicIds: parsed.topicIds,
      chunkCount: docChunks.length,
      importedAt: startedAt,
      privateUseOnly: true,
    });
  }
  const runs = [
    {
      id: `source-run:${randomUUID()}`,
      rootPath: '<private-local-source-root>',
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
      documentCount: documents.length,
      chunkCount: chunks.length,
      bytesScanned,
      warnings: documents.filter((document) => document.needsOcr).length
        ? ['Some canonical PDFs need OCR or paired EPUB fallback before they count as searchable source coverage.']
        : [],
      errors: [],
      policy: SOURCE_POLICY,
    },
  ];
  const bundle = {
    app: 'QuantVault',
    kind: 'cfa-source-vault',
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    policy: SOURCE_POLICY,
    documents,
    chunks,
    runs,
  };
  await mkdir(PRIVATE_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(LATEST_BUNDLE, `${JSON.stringify(bundle)}\n`);
  await writeCoverageReport(bundle);
  await writeFile(
    join(REPORT_DIR, 'cfa-source-dedupe-report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), canonicalDocuments: canonicalFiles.size, skippedDuplicates: relevant.length - canonicalFiles.size }, null, 2)}\n`,
  );
  console.log(`Ingest complete: ${documents.length} documents, ${chunks.length} chunks. Wrote ${LATEST_BUNDLE}`);
}

async function writeCoverageReport(bundle) {
  const levelCounts = {};
  const searchableLevelCounts = {};
  const topicCounts = {};
  const blockedDocuments = [];
  bundle.documents.forEach((document) => {
    levelCounts[document.level] = (levelCounts[document.level] || 0) + 1;
    if (document.chunkCount > 0)
      searchableLevelCounts[document.level] = (searchableLevelCounts[document.level] || 0) + 1;
    if (document.canonical && document.format === 'pdf' && document.chunkCount === 0)
      blockedDocuments.push(document.id);
    document.topicIds.forEach((topicId) => {
      topicCounts[topicId] = (topicCounts[topicId] || 0) + 1;
    });
  });
  const report = {
    generatedAt: new Date().toISOString(),
    documentCount: bundle.documents.length,
    chunkCount: bundle.chunks.length,
    searchableDocumentCount: bundle.documents.filter((document) => document.chunkCount > 0).length,
    searchableLevelCounts,
    blockedZeroChunkPdfCount: blockedDocuments.length,
    blockedDocuments,
    levelCounts,
    topicCounts,
    documents: bundle.documents.map(
      ({ id, title, level, year, publisher, format, canonical, topicIds, chunkCount, needsOcr }) => ({
        id,
        title,
        level,
        year,
        publisher,
        format,
        canonical,
        topicIds,
        chunkCount,
        needsOcr,
      }),
    ),
  };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, 'cfa-source-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);
}

async function commandBundle(options) {
  const input = resolve(String(options.input || LATEST_BUNDLE));
  if (!existsSync(input)) throw new Error(`No source bundle found at ${input}. Run npm run cfa:source:ingest first.`);
  const payload = JSON.parse(await readFile(input, 'utf8'));
  await mkdir(PRIVATE_DIR, { recursive: true });
  const output = resolve(
    String(
      options.output ||
        join(
          PRIVATE_DIR,
          `quantvault-cfa-source-${new Date()
            .toISOString()
            .replace(/[^0-9]/g, '')
            .slice(0, 14)}.qvsource`,
        ),
    ),
  );
  await writeFile(output, `${JSON.stringify(payload)}\n`);
  console.log(`Wrote private source bundle ${output}`);
}

async function commandCoverage(options) {
  const input = resolve(String(options.input || LATEST_BUNDLE));
  if (!existsSync(input)) {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(
      join(REPORT_DIR, 'cfa-source-coverage.json'),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: 'no-source-bundle',
          sourceBundle: '<private-local-source-bundle>',
          documentCount: 0,
          chunkCount: 0,
          levelCounts: {},
          topicCounts: {},
          documents: [],
          message:
            'No private CFA source bundle has been ingested yet. Run npm run cfa:source:ingest to create one locally.',
        },
        null,
        2,
      )}\n`,
    );
    console.log('No private source bundle found. Wrote empty dist/reports/cfa-source-coverage.json');
    return;
  }
  await writeCoverageReport(JSON.parse(await readFile(input, 'utf8')));
  console.log('Wrote dist/reports/cfa-source-coverage.json');
}

async function trackedFiles() {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: process.cwd(), windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function existingFilesUnder(root) {
  if (!existsSync(root)) return [];
  return walk(root);
}

async function commandAudit() {
  const violations = [];
  const tracked = await trackedFiles();
  const generated = [...(await existingFilesUnder('dist')), ...(await existingFilesUnder('qa-screenshots'))];
  const files = [...new Set([...tracked, ...generated])].filter(
    (file) => !file.includes('node_modules') && !file.includes('.git/'),
  );
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const extension = extname(file).toLowerCase();
    const info = existsSync(file) ? await stat(file) : { size: 0 };
    const inArtifactRoot = normalized.startsWith('dist/') || normalized.startsWith('qa-screenshots/');
    const suspiciousName =
      /(_archive_metadata|schweser|wiley|official curriculum|curriculum volume|source-vault|\.qvsource)/i.test(
        normalized,
      );
    if (normalized.startsWith('dist/source-vault/') || normalized.includes('/source-vault/')) {
      violations.push(`${file} is a private source-vault artifact path and must not live in release output.`);
    }
    if (['.qvsource', '.epub', '.pdf'].includes(extension)) {
      violations.push(`${file} is a source-material artifact and must not be tracked or uploaded.`);
    }
    if (['.txt', '.html', '.htm', '.xml'].includes(extension) && suspiciousName) {
      violations.push(`${file} looks like extracted source text and must remain outside the repo/artifact roots.`);
    }
    if (!inArtifactRoot && info.size > 1_500_000 && !/\.(png|jpg|jpeg|webp|svg)$/i.test(file)) {
      violations.push(`${file} is unusually large for tracked app/docs content.`);
    }
  }
  if (violations.length) {
    violations.forEach((violation) => console.error(`source-audit: ${violation}`));
    process.exitCode = 1;
    return;
  }
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(
    join(REPORT_DIR, 'cfa-source-policy.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), policy: SOURCE_POLICY, scannedFiles: files.length, violations }, null, 2)}\n`,
  );
  console.log(
    'Source audit passed: no private source bundles or source documents found in tracked files or release artifact roots.',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(String(options.root || process.env.CFA_SOURCE_ROOT || DEFAULT_ROOT));
  if (options.command === 'help') {
    console.log(
      'Usage: node scripts/cfa-source-vault.mjs <inventory|ingest|bundle|coverage|audit> [--root path] [--input bundle] [--output bundle]',
    );
    return;
  }
  if (
    options.command !== 'audit' &&
    options.command !== 'bundle' &&
    options.command !== 'coverage' &&
    !existsSync(root)
  ) {
    throw new Error(`CFA source root does not exist: ${root}`);
  }
  if (options.command === 'inventory') await commandInventory(root);
  else if (options.command === 'ingest') await commandIngest(root, options);
  else if (options.command === 'bundle') await commandBundle(options);
  else if (options.command === 'coverage') await commandCoverage(options);
  else if (options.command === 'audit') await commandAudit();
  else throw new Error(`Unknown source vault command: ${options.command}`);
}

export {
  classifyPath,
  extractEpubText,
  extractPdfText,
  isSafeZipEntryName,
  normalizeText,
  pickCanonical,
  probePdfQuality,
  readZipEntries,
  sha256,
  textChunksFromText,
  visibleText,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
