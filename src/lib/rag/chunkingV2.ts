/**
 * RAG-5 — structure-aware chunking v2.
 *
 * The historical chunker is a fixed-size sliding window over raw text. That
 * splits a single Learning Outcome Statement (LOS) / heading section across two
 * chunks (so neither contains the whole answer) and merges unrelated sections
 * into one chunk (so retrieval pulls in noise). v2 chunks on DOCUMENT STRUCTURE:
 *
 *   1. Split the document into sections on heading / LOS boundaries. We detect:
 *        - Markdown ATX headings:           `#`..`######`
 *        - Numbered LOS lines:              `1.`, `2.3`, `12.4.1` at line start
 *        - LOS-letter outcome markers:      `LOS 9.a`, `LOS 12.b)` …
 *        - ALL-CAPS / "Reading N" style section titles on their own line
 *   2. Each section becomes ONE chunk (heading + body), so an LOS stays intact.
 *   3. WINDOWED FALLBACK only INSIDE oversized sections: a section longer than
 *      `maxChars` is sub-split with the existing sliding-window chunker (with
 *      overlap), and every sub-chunk re-prepends the section heading so the
 *      locator + lexical signal of the heading survives the split.
 *
 * The legacy windowed chunker is kept and EXPORTED as {@link windowChunk} so it
 * remains the fallback (RULES: "keep the existing chunker as fallback"). When a
 * document has NO detectable structure, v2 degrades to exactly the windowed
 * behaviour over the whole text.
 *
 * Pure + deterministic + offline. No LLM, no network. Output chunks carry a
 * stable `id` derived from `documentId` + ordinal so re-chunking is idempotent.
 */

/** A produced chunk, shaped to feed `chunks.upsert` (SourceChunkInput-compatible). */
export interface ChunkV2 {
  id: string;
  documentId: string;
  /** Heading / LOS locator for citation chips (e.g. "LOS 9.a" or "## Duration"). */
  locator: string;
  text: string;
  /** 0-based section ordinal within the document. */
  section: number;
  /** Sub-window index within an oversized section (0 when the section fit). */
  window: number;
}

export interface ChunkingV2Options {
  documentId: string;
  /** Target max characters per chunk before the windowed fallback kicks in. Default 1200. */
  maxChars?: number;
  /** Sliding-window overlap (chars) used only inside oversized sections. Default 150. */
  overlap?: number;
  /** Fallback locator when a section has no detectable heading. Default 'section'. */
  defaultLocator?: string;
}

interface RawSection {
  heading: string;
  body: string;
}

// Heading / LOS boundary detectors, tried in order. Each matches a WHOLE line.
const HEADING_PATTERNS: RegExp[] = [
  // Markdown ATX heading: "## Modified Duration"
  /^#{1,6}\s+\S.*$/,
  // Explicit LOS marker: "LOS 9.a", "LOS 12.b)", "Learning Outcome 3.c"
  /^(?:LOS|Learning\s+Outcome)\s+\d+\.[a-z]\)?\b.*$/i,
  // Numbered section: "1.", "2.3", "12.4.1  Title"
  /^\d+(?:\.\d+){0,3}\.?\s+\S.*$/,
  // "Reading 9" / "Module 3" / "Chapter 12" style
  /^(?:Reading|Module|Chapter|Section)\s+\d+\b.*$/i,
];

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Don't treat a very long line as a heading even if it pattern-matches — real
  // headings are short. (Guards against a numbered list item that wraps prose.)
  if (trimmed.length > 120) return false;
  return HEADING_PATTERNS.some((re) => re.test(trimmed));
}

/** Strip leading markdown `#` and surrounding whitespace from a heading line. */
function cleanHeading(line: string): string {
  return line.trim().replace(/^#{1,6}\s+/, '').trim();
}

/**
 * Split raw text into heading-bounded sections. Text before the first heading
 * becomes a leading section with an empty heading. When no heading is detected
 * at all, returns a single section spanning the whole text.
 */
export function splitIntoSections(text: string): RawSection[] {
  const lines = (text || '').split(/\r?\n/);
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    if (isHeadingLine(line)) {
      if (current) {
        sections.push({ heading: current.heading, body: current.body.trimEnd() });
      } else if (preamble.join('').trim()) {
        sections.push({ heading: '', body: preamble.join('\n').trim() });
      }
      preamble = [];
      current = { heading: cleanHeading(line), body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    } else {
      preamble.push(line);
    }
  }
  if (current) {
    sections.push({ heading: current.heading, body: current.body.trimEnd() });
  } else if (preamble.join('').trim()) {
    sections.push({ heading: '', body: preamble.join('\n').trim() });
  }

  // Drop sections that are entirely empty (heading-less + blank body).
  return sections.filter((s) => s.heading.trim() || s.body.trim());
}

/**
 * The legacy sliding-window chunker, preserved as the fallback. Splits `text`
 * into overlapping windows of at most `maxChars`, breaking on a sentence/space
 * boundary near the window edge where possible so windows don't cut mid-word.
 */
export function windowChunk(text: string, maxChars: number, overlap: number): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const step = Math.max(1, maxChars - Math.max(0, overlap));
  const windows: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + maxChars);
    if (end < clean.length) {
      // Prefer to break on the last sentence end, else the last space, in the
      // final ~20% of the window so we don't cut a word/sentence in half.
      const tail = clean.slice(start, end);
      const window = Math.floor(maxChars * 0.8);
      const sentenceBreak = Math.max(
        tail.lastIndexOf('. '),
        tail.lastIndexOf('.\n'),
        tail.lastIndexOf('? '),
        tail.lastIndexOf('! '),
      );
      const spaceBreak = tail.lastIndexOf(' ');
      if (sentenceBreak >= window) end = start + sentenceBreak + 1;
      else if (spaceBreak >= window) end = start + spaceBreak + 1;
    }
    windows.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(start + step, end - overlap);
  }
  return windows.filter(Boolean);
}

/**
 * Structure-aware chunk a document. Each heading/LOS section becomes one chunk;
 * oversized sections sub-split with {@link windowChunk} (the legacy fallback),
 * re-prepending the heading to every sub-chunk.
 */
export function chunkDocumentV2(text: string, options: ChunkingV2Options): ChunkV2[] {
  const maxChars = options.maxChars ?? 1200;
  const overlap = options.overlap ?? 150;
  const fallbackLocator = options.defaultLocator ?? 'section';
  const docId = options.documentId;

  const sections = splitIntoSections(text);
  const chunks: ChunkV2[] = [];

  sections.forEach((section, sectionIndex) => {
    const locator = section.heading.trim() || `${fallbackLocator} ${sectionIndex + 1}`;
    const sectionText = section.heading.trim()
      ? `${section.heading.trim()}\n${section.body}`.trim()
      : section.body.trim();
    if (!sectionText) return;

    if (sectionText.length <= maxChars) {
      chunks.push({
        id: `${docId}::s${sectionIndex}`,
        documentId: docId,
        locator,
        text: sectionText,
        section: sectionIndex,
        window: 0,
      });
      return;
    }

    // Oversized section → windowed fallback over the BODY, heading re-prepended.
    const bodyWindows = windowChunk(section.body, maxChars, overlap);
    bodyWindows.forEach((win, windowIndex) => {
      const headed = section.heading.trim() ? `${section.heading.trim()}\n${win}` : win;
      chunks.push({
        id: `${docId}::s${sectionIndex}::w${windowIndex}`,
        documentId: docId,
        locator: bodyWindows.length > 1 ? `${locator} (${windowIndex + 1}/${bodyWindows.length})` : locator,
        text: headed,
        section: sectionIndex,
        window: windowIndex,
      });
    });
  });

  return chunks;
}
