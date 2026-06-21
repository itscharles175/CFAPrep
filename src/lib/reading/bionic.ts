/**
 * A11Y-1 — bionic-reading transform (pure, DOM-free core).
 *
 * Bionic reading bolds the leading "fixation" of each word so the eye anchors on
 * the salient prefix and skims the rest. The split heuristic below is the common
 * one: short words bold the first character, longer words bold a growing prefix
 * (~40-50%), capped so very long words don't go fully bold.
 *
 * This file is intentionally split from the DOM controller so the fixation logic
 * is unit-testable without a document, and so the controller can reuse it to
 * build text nodes safely (no innerHTML / no HTML injection — see readingEngine).
 */

/**
 * Compute how many leading characters of a single alphanumeric word should be
 * emphasised. Mirrors the widely-used "Bionic Reading" weighting:
 *   len 1     → 1
 *   len 2-3   → 1
 *   len 4+    → ceil(len * 0.4), capped at len - 1 so a tail always remains.
 */
export function fixationLength(word: string): number {
  const len = word.length;
  if (len <= 1) return len;
  if (len <= 3) return 1;
  const weighted = Math.ceil(len * 0.4);
  return Math.min(weighted, len - 1);
}

/** One run of source text: either an emphasised fixation prefix or plain tail. */
export interface BionicRun {
  text: string;
  bold: boolean;
}

/**
 * Split a run of text into bionic runs, preserving ALL original characters
 * (whitespace + punctuation pass through as non-bold runs, so reassembling the
 * `text` of every run yields the input verbatim). Word boundaries are matched on
 * letters/digits so contractions and numbers are treated as single words.
 *
 * Returns a flat, order-preserving list — the caller turns each run into a text
 * node (plain) or a `<b>` element (bold), never raw HTML.
 */
export function toBionicRuns(input: string): BionicRun[] {
  if (!input) return [];
  const runs: BionicRun[] = [];
  // A "word" is a maximal run of letters/digits (incl. unicode letters); any
  // other run (spaces, punctuation) is captured verbatim between words.
  const tokenRe = /([\p{L}\p{N}]+)|([^\p{L}\p{N}]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(input)) !== null) {
    const word = match[1];
    if (word) {
      const split = fixationLength(word);
      if (split > 0) runs.push({ text: word.slice(0, split), bold: true });
      if (split < word.length) runs.push({ text: word.slice(split), bold: false });
    } else {
      // Separator run (match[2]) — never emphasised.
      runs.push({ text: match[2], bold: false });
    }
  }
  return runs;
}
