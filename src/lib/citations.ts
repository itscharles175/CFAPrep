// Citation parsing for open-notebook grounded answers.
//
// Grounded answers come back with inline `[source:xxxx]` markers (sometimes
// grouped: `[source:abc, source:def]`). Replace those with footnote-style
// numbers and return the ordered, deduped list of cited source ids so the
// caller can render a legend.

export type CitationToken =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; refs: number[] };

export interface ParsedCitations {
  tokens: CitationToken[];
  /** Source ids in the order they first appear in the text (1-indexed by reference). */
  sourceIds: string[];
}

// Either a stand-alone marker  `[source:xxx]`  or grouped  `[source:a, source:b]`
// Captures the inner payload so we can split on commas.
const CITATION_RE = /\[\s*((?:source:[A-Za-z0-9_-]+\s*(?:,\s*source:[A-Za-z0-9_-]+\s*)*))\]/g;

export function parseCitations(answer: string): ParsedCitations {
  const tokens: CitationToken[] = [];
  const sourceIds: string[] = [];
  const indexById = new Map<string, number>();

  function refFor(id: string): number {
    const existing = indexById.get(id);
    if (existing != null) return existing;
    sourceIds.push(id);
    const next = sourceIds.length;
    indexById.set(id, next);
    return next;
  }

  let lastIndex = 0;
  for (const match of answer.matchAll(CITATION_RE)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      tokens.push({ kind: 'text', text: answer.slice(lastIndex, matchStart) });
    }
    const payload = match[1];
    const ids = payload
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const refs = ids.map((id) => refFor(id));
    tokens.push({ kind: 'cite', refs });
    lastIndex = matchStart + match[0].length;
  }
  if (lastIndex < answer.length) {
    tokens.push({ kind: 'text', text: answer.slice(lastIndex) });
  }
  return { tokens, sourceIds };
}
