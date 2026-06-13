import type { ParsedPrepTest } from "./types";

/** Heuristic: numbered stems like `1.` or `Question 1` in extracted PDF text. */
export function countRawQuestions(rawText: string): number {
  if (!rawText.trim()) return 0;
  const numbered = rawText.match(/(?:^|\n)\s*\d{1,2}\.\s+/gm);
  const labeled = rawText.match(/(?:^|\n)\s*question\s+\d{1,2}\b/gim);
  return Math.max(numbered?.length ?? 0, labeled?.length ?? 0);
}

export function totalParsedQuestions(parsed: ParsedPrepTest): number {
  return parsed.sections.reduce((n, s) => n + s.questions.length, 0);
}

export interface ImportCountMismatch {
  rawTotal: number;
  parsedTotal: number;
  delta: number;
  /** Per-section: parsed count differs from even split of raw estimate. */
  sectionFlags: boolean[];
}

export function getImportCountMismatch(
  parsed: ParsedPrepTest,
  rawText: string,
): ImportCountMismatch {
  const rawTotal = countRawQuestions(rawText);
  const parsedTotal = totalParsedQuestions(parsed);
  const delta = rawTotal - parsedTotal;
  const sectionFlags = parsed.sections.map((sec, _si, arr) => {
    if (rawTotal === 0) return false;
    const expected =
      arr.length > 0 ? Math.round(rawTotal / arr.length) : sec.questions.length;
    return Math.abs(sec.questions.length - expected) >= 1 || delta !== 0;
  });
  // Mark all sections when global totals disagree.
  if (Math.abs(delta) >= 1) {
    return {
      rawTotal,
      parsedTotal,
      delta,
      sectionFlags: parsed.sections.map(() => true),
    };
  }
  return { rawTotal, parsedTotal, delta, sectionFlags };
}

/** Line indices in raw text that look like question boundaries (for diff highlight). */
export function rawQuestionLineIndices(rawText: string): Set<number> {
  const lines = rawText.split("\n");
  const out = new Set<number>();
  lines.forEach((line, i) => {
    if (/^\s*\d{1,2}\.\s+/.test(line) || /^\s*question\s+\d{1,2}\b/i.test(line)) {
      out.add(i);
    }
  });
  return out;
}
