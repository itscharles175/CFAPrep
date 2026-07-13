/**
 * RAG-6 — reciprocal-rank fusion (RRF) + calibrated dedup.
 *
 * When retrieval draws from MULTIPLE signals/sources — BM25 vs vector, host
 * curriculum vs open-notebook sources, or a reranked over-retrieve list — their
 * raw scores live on incomparable scales (a normalised BM25 0..1 is not the same
 * "0.7" as a cosine-mapped 0..1). Naive `sort by score` then lets one channel's
 * scale dominate. RRF sidesteps this entirely by fusing on RANK, not score:
 *
 *     RRF(d) = Σ_lists  1 / (k + rank_list(d))         (rank is 1-based)
 *
 * The constant `k` (default 60, the canonical TREC value) damps the contribution
 * of low-ranked items so the head of each list matters most. A document near the
 * top of several lists beats one that's #1 in a single list — exactly the
 * consensus behaviour we want from a hybrid.
 *
 * CALIBRATED DEDUP: the same chunk often appears in more than one list (host
 * BM25 + host vector, or host + notebook). We dedupe by id, SUM each id's RRF
 * contribution across the lists it appears in (so agreement is rewarded), and —
 * for near-duplicate TEXT with different ids (e.g. an overlapping windowed chunk
 * and its parent) — collapse by a normalised-text key, keeping the higher-RRF
 * representative. This stops one passage from eating several context-budget slots.
 *
 * Pure + deterministic + offline: no LLM, no network, no IndexedDB. Ties in the
 * fused score break by ascending id so output is stable run-to-run.
 */

/** The minimal shape a fusion input row needs: a stable id and its text. */
export interface FusionItem {
  id: string;
  text?: string;
}

/** One ranked list to fuse. Order IS the rank (index 0 = rank 1). */
export interface RankedList<T extends FusionItem> {
  items: T[];
  /**
   * Optional per-list weight (default 1). Lets a trusted channel (e.g. a
   * reranked list) count more without changing the rank math.
   */
  weight?: number;
}

export interface FusionOptions {
  /** RRF damping constant. Default 60 (canonical TREC value). */
  k?: number;
  /**
   * Collapse near-duplicate TEXT (different ids, ~same passage) using a
   * normalised-text key, keeping the higher-RRF representative. Default `true`.
   */
  dedupeByText?: boolean;
  /** Cap the fused output length. Default: unbounded. */
  limit?: number;
}

/** A fused result: the original item plus its fused RRF score + provenance. */
export interface FusedResult<T extends FusionItem> {
  item: T;
  /** Summed (weighted) reciprocal-rank score across the lists it appeared in. */
  rrfScore: number;
  /** How many input lists contributed to this id. */
  listHits: number;
}

const DEFAULT_RRF_K = 60;

/** Normalise text to a dedupe key: lowercased, whitespace-collapsed, trimmed. */
export function textKey(text: string | undefined): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Reciprocal-rank fusion over N ranked lists with calibrated dedup.
 *
 * @param lists ordered candidate lists (index 0 = best). Each list's items are
 *   ranked by their position; their own scores are intentionally ignored so
 *   incomparable score scales can't skew the fusion.
 * @returns fused results sorted by descending RRF score (ties → ascending id).
 */
export function reciprocalRankFusion<T extends FusionItem>(
  lists: Array<RankedList<T>>,
  options: FusionOptions = {},
): Array<FusedResult<T>> {
  const k = options.k ?? DEFAULT_RRF_K;
  const dedupeByText = options.dedupeByText !== false;

  // Accumulate RRF by id. First-seen item wins as the representative for that id.
  const byId = new Map<string, FusedResult<T>>();
  for (const list of lists) {
    const weight = typeof list.weight === 'number' && list.weight > 0 ? list.weight : 1;
    list.items.forEach((item, index) => {
      if (!item || typeof item.id !== 'string') return;
      const rank = index + 1; // 1-based
      const contribution = weight * (1 / (k + rank));
      const existing = byId.get(item.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.listHits += 1;
      } else {
        byId.set(item.id, { item, rrfScore: contribution, listHits: 1 });
      }
    });
  }

  let fused = Array.from(byId.values());

  // Calibrated text-dedup: collapse different-id rows whose normalised text is
  // identical, keeping the higher-RRF representative (and accumulating the loser's
  // listHits so consensus across near-dupes still counts).
  if (dedupeByText) {
    const byText = new Map<string, FusedResult<T>>();
    const passthrough: Array<FusedResult<T>> = [];
    for (const row of fused) {
      const key = textKey(row.item.text);
      if (!key) {
        // No text to compare on — keep as-is (id-dedup already applied).
        passthrough.push(row);
        continue;
      }
      const seen = byText.get(key);
      if (!seen) {
        byText.set(key, row);
      } else if (row.rrfScore > seen.rrfScore) {
        // New row is the better representative; fold the old one's hits in.
        row.listHits += seen.listHits;
        byText.set(key, row);
      } else {
        // Keep the existing representative; absorb this row's hits.
        seen.listHits += row.listHits;
      }
    }
    fused = [...passthrough, ...byText.values()];
  }

  fused.sort(
    (a, b) =>
      b.rrfScore - a.rrfScore ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );

  return typeof options.limit === 'number' ? fused.slice(0, Math.max(0, options.limit)) : fused;
}
