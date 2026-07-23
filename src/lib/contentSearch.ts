/**
 * UX-2 — unified CONTENT search for the command palette.
 *
 * The palette's ROUTE search (modules, tools, jump-to-domain) shipped in UB6
 * (`TopBar.tsx`). This module adds the orthogonal half: searching the actual
 * STUDY CONTENT the user has — and unifying it across domains behind one query:
 *
 *   1. HOST curriculum chunks   — `localRag.retrieveChunks` over the active
 *      storage driver (Dexie BM25 / SurrealDB hybrid). These are the CFA / Quant
 *      / Excel source-vault chunks the user ingested.
 *   2. LSAT questions           — the LSAT sidecar's existing keyword search
 *      (`GET /api/search/questions`, FTS5 over stem+prompt). No backend change:
 *      we reuse the shipped endpoint.
 *   3. open-notebook sources    — the INT-3 union surface
 *      (`openNotebook.searchNotebookSources`), the user's embedded notebook
 *      material reached through the optional :5055 sidecar.
 *
 * Results are normalised to one {@link ContentHit} shape with a `deepLink` the
 * palette can act on:
 *   - LSAT question hits soft-navigate (`navigateDomain`) to the LSAT question
 *     browser (`/lsat/bank`) — cross-domain hop, not the host router.
 *   - Host curriculum + notebook hits route to the host source vault
 *     (`/vault?...`) where the chunk is surfaced.
 *
 * ACTIVE-DOMAIN WEIGHTING: every hit carries the study domain it belongs to, and
 * hits matching the domain the user is currently in (derived from the URL path)
 * get a small score bump so the most contextually relevant content floats up —
 * mirroring the route palette's UB6 current-domain priority, kept small enough
 * that a strong textual match from another domain still wins.
 *
 * DEGRADE-GRACEFULLY: every source is fetched independently and any one failing
 * (sidecar down, driver without chunk search, notebook disabled) simply
 * contributes no rows — the union never throws. This makes the feature safe to
 * wire into the always-mounted TopBar search surface.
 */

import { retrieveChunks } from './localRag';
import { searchNotebookSources, getOpenNotebookSettings, notebookSourcesAvailable } from './openNotebook';
import type { NotebookSourceHit } from './openNotebook';
import { fetchLsatSidecar } from './lsatSidecarClient';
import type { ChunkSearchResult } from './storage/types';
import type { paths } from '../domains/lsat/lib/api.gen';

const LSAT_QUESTION_SEARCH_PATH = '/api/search/questions' satisfies keyof paths;

/** The study domain a content hit belongs to (mirrors the palette's UB6 set). */
export type ContentDomain = 'cfa' | 'lsat' | 'quant' | 'excel' | 'vault' | 'general';

/** Which content source a hit came from — drives the row's badge/icon. */
export type ContentSource = 'host' | 'lsat-question' | 'notebook';

/** Deep-link target into the LSAT question browser (host soft-navigates here). */
export const LSAT_QUESTION_BROWSER_PATH = '/lsat/bank';
/** Deep-link target into the LSAT SRS review flow (alternative LSAT target). */
export const LSAT_SRS_PATH = '/lsat/srs';

/** A single unified content-search result row. */
export interface ContentHit {
  /** Stable id for React keys + dedupe (`source:nativeId`). */
  id: string;
  /** One-line title for the row. */
  title: string;
  /** Secondary line (locator / source / domain context). */
  subtitle?: string;
  /** Which underlying source produced this hit. */
  source: ContentSource;
  /** The study domain this content belongs to (for badge + active-domain bump). */
  domain: ContentDomain;
  /** Where to send the user. */
  deepLink: string;
  /**
   * When true the deep-link crosses into another top-level domain (LSAT) and the
   * caller MUST soft-navigate via `navigateDomain` rather than the host router.
   */
  external: boolean;
  /** 0..1 relevance score (already includes the active-domain bump). */
  score: number;
}

export interface ContentSearchOptions {
  query: string;
  /** Current URL path — used to derive the active domain for result weighting. */
  pathname?: string;
  /** Max hits to return overall. Default 8. */
  limit?: number;
  /** Per-source fetch cap before the union is merged + truncated. Default 6. */
  perSourceLimit?: number;
  signal?: AbortSignal;
  /**
   * Test seams — override any source's fetch. Each defaults to the real
   * implementation; an override that throws/returns `[]` simulates a degraded
   * source without touching the network or a driver.
   */
  searchHost?: (input: { query: string; limit: number; domain?: string; signal?: AbortSignal }) => Promise<ChunkSearchResult[]>;
  searchLsat?: (input: { query: string; limit: number; signal?: AbortSignal }) => Promise<LsatQuestionHit[]>;
  searchNotebook?: (input: { query: string; limit: number; signal?: AbortSignal }) => Promise<NotebookSourceHit[]>;
}

/** A light LSAT question result from `GET /api/search/questions`. */
export interface LsatQuestionHit {
  questionId: number | string;
  qType?: string;
  source?: string;
  stem: string;
  /**
   * 0..1 relevance. The FTS endpoint returns rows in rank order but no numeric
   * score, so {@link searchLsatQuestions} synthesises a descending score from the
   * result position — keeping top FTS matches competitive in the cross-source union.
   */
  score: number;
}

/** Documented `GET /api/search/questions` body — still `LegacySuccessResponse`
 * on the wire, so read the per-row fields defensively (matches the backend's
 * `app/routers/search_routes.py` + `app/search.py`). */
interface RawQuestionSearchResponse {
  query?: string;
  results?: Array<{
    question_id?: number | string;
    q_type?: string;
    source?: string;
    stem?: string;
  }>;
}

/** The active study domain from a URL path (mirrors TopBar's `activeDomainForPath`). */
export function activeContentDomain(pathname: string | undefined): ContentDomain {
  const path = pathname || '';
  if (path === '/lsat' || path.startsWith('/lsat/')) return 'lsat';
  if (path === '/cfa' || path.startsWith('/cfa/')) return 'cfa';
  if (path === '/quant' || path.startsWith('/quant/')) return 'quant';
  if (path === '/excel' || path.startsWith('/excel/')) return 'excel';
  if (path === '/vault' || path.startsWith('/vault')) return 'vault';
  return 'general';
}

/** Map a host curriculum chunk's `domain` tag onto the palette domain set. The
 * driver stores free-form domain strings (e.g. "cfa", "quant"); anything we
 * don't recognise (incl. the open-notebook synthetic tag) falls back to 'vault'
 * since host chunks all surface through the source vault. */
function chunkDomain(raw: string | undefined): ContentDomain {
  switch ((raw || '').toLowerCase()) {
    case 'cfa':
      return 'cfa';
    case 'lsat':
      return 'lsat';
    case 'quant':
      return 'quant';
    case 'excel':
      return 'excel';
    default:
      return 'vault';
  }
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

function snippetOf(text: string, max = 120): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Fetch the LSAT keyword-search hits from the sidecar. Degrading + timeout-
 * guarded like the other LSAT bridges: any failure (down, non-2xx, shape drift)
 * resolves to `[]` so the union simply omits LSAT rows.
 */
export async function searchLsatQuestions(
  input: { query: string; limit: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<LsatQuestionHit[]> {
  const query = (input.query || '').trim();
  if (!query) return [];
  try {
    const params = new URLSearchParams({ q: query, limit: String(Math.max(1, Math.min(100, input.limit))) });
    const res = await fetchLsatSidecar(`${LSAT_QUESTION_SEARCH_PATH}?${params.toString()}`, {
      timeoutMs: input.timeoutMs ?? 2500,
      signal: input.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as RawQuestionSearchResponse;
    const rows = Array.isArray(data.results) ? data.results : [];
    // The endpoint already returns rows in FTS rank order. Synthesise a smooth
    // descending 0..1 score (top hit ~1, tail toward ~0.5) so the strongest LSAT
    // matches stay competitive against the host chunks' real BM25/vector scores.
    const total = rows.length;
    const hits: LsatQuestionHit[] = [];
    rows.forEach((row, index) => {
      if (row?.question_id == null) return;
      hits.push({
        questionId: row.question_id,
        qType: typeof row.q_type === 'string' ? row.q_type : undefined,
        source: typeof row.source === 'string' ? row.source : undefined,
        stem: typeof row.stem === 'string' ? row.stem : '',
        score: total > 0 ? 1 - (0.5 * index) / total : 0,
      });
    });
    return hits;
  } catch {
    return [];
  }
}

/** Host curriculum chunks via the storage driver. Degrades to `[]` on any
 * failure (e.g. a driver without `chunks` search) so it never breaks the union. */
async function defaultSearchHost(
  input: { query: string; limit: number; domain?: string; signal?: AbortSignal },
): Promise<ChunkSearchResult[]> {
  try {
    // Exclude the notebook union here — notebook sources are fetched as their own
    // source below so they keep their distinct badge + deep-link, rather than
    // being folded into the host curriculum rows.
    return await retrieveChunks({
      question: input.query,
      limit: input.limit,
      includeNotebookSources: false,
      signal: input.signal,
    });
  } catch {
    return [];
  }
}

/** open-notebook sources via the INT-3 union surface. Only attempted when the
 * sidecar is enabled + reachable; degrades to `[]` otherwise (OPS-5). */
async function defaultSearchNotebook(
  input: { query: string; limit: number; signal?: AbortSignal },
): Promise<NotebookSourceHit[]> {
  try {
    const settings = await getOpenNotebookSettings();
    if (!(await notebookSourcesAvailable(settings))) return [];
    return await searchNotebookSources({
      baseUrl: settings.baseUrl,
      query: input.query,
      limit: input.limit,
      signal: input.signal,
    });
  } catch {
    return [];
  }
}

/**
 * Run the unified content search: union host curriculum chunks + LSAT questions
 * + open-notebook sources for `query`, weight by the active domain, and return
 * the top {@link ContentHit}s ready for the palette.
 *
 * Never throws — every source is independent and a failing source contributes no
 * rows. Returns `[]` for an empty/whitespace query.
 */
export async function searchAllContent(opts: ContentSearchOptions): Promise<ContentHit[]> {
  const query = (opts.query || '').trim();
  if (!query) return [];

  const limit = opts.limit ?? 8;
  const perSource = opts.perSourceLimit ?? 6;
  const activeDomain = activeContentDomain(opts.pathname);

  const searchHost = opts.searchHost ?? defaultSearchHost;
  const searchLsat = opts.searchLsat ?? ((input) => searchLsatQuestions(input));
  const searchNotebook = opts.searchNotebook ?? defaultSearchNotebook;

  // `allSettled` so one source rejecting can never reject the union — though the
  // defaults already swallow their own failures, an overriding test seam might not.
  const [hostRes, lsatRes, notebookRes] = await Promise.allSettled([
    searchHost({ query, limit: perSource, signal: opts.signal }),
    searchLsat({ query, limit: perSource, signal: opts.signal }),
    searchNotebook({ query, limit: perSource, signal: opts.signal }),
  ]);

  const hostChunks = hostRes.status === 'fulfilled' ? hostRes.value : [];
  const lsatHits = lsatRes.status === 'fulfilled' ? lsatRes.value : [];
  const notebookHits = notebookRes.status === 'fulfilled' ? notebookRes.value : [];

  const hits: ContentHit[] = [];

  // Host curriculum chunks → source vault deep-link.
  for (const chunk of hostChunks) {
    const domain = chunkDomain(chunk.domain);
    hits.push({
      id: `host:${chunk.id}`,
      title: snippetOf(chunk.text) || chunk.locator || chunk.documentId,
      subtitle: [chunk.locator, 'curriculum'].filter(Boolean).join(' · '),
      source: 'host',
      domain,
      deepLink: `/vault?sourceQuery=${encodeURIComponent(query)}&chunk=${encodeURIComponent(chunk.id)}`,
      external: false,
      score: clampScore(chunk.score),
    });
  }

  // LSAT questions → soft-nav into the LSAT question browser.
  for (const hit of lsatHits) {
    const nativeId = String(hit.questionId);
    hits.push({
      id: `lsat-question:${nativeId}`,
      title: snippetOf(hit.stem) || `LSAT question ${nativeId}`,
      subtitle: [hit.qType, hit.source, 'LSAT question'].filter(Boolean).join(' · '),
      source: 'lsat-question',
      domain: 'lsat',
      deepLink: `${LSAT_QUESTION_BROWSER_PATH}?q=${encodeURIComponent(query)}&question=${encodeURIComponent(nativeId)}`,
      external: true,
      score: clampScore(hit.score),
    });
  }

  // open-notebook sources → host vault (the notebook material is reached through
  // the same backend the vault surfaces).
  for (const hit of notebookHits) {
    hits.push({
      id: `notebook:${hit.id}`,
      title: snippetOf(hit.title) || hit.locator || hit.id,
      subtitle: [hit.locator, 'notebook source'].filter(Boolean).join(' · '),
      source: 'notebook',
      domain: 'vault',
      deepLink: `/vault?sourceQuery=${encodeURIComponent(query)}&notebook=${encodeURIComponent(hit.id)}`,
      external: false,
      score: clampScore(hit.score),
    });
  }

  // Active-domain weighting: bump hits in the domain the user is currently in so
  // the most contextually relevant content floats up. The bump is small (mirrors
  // the route palette's UB6 priority) so a strong cross-domain textual match can
  // still outrank a weak same-domain one. 'general' (no active study domain) adds
  // no bump — every source competes on raw relevance.
  const DOMAIN_BUMP = 0.15;
  const ranked = hits
    .map((hit) => ({
      hit,
      sortScore: hit.score + (activeDomain !== 'general' && hit.domain === activeDomain ? DOMAIN_BUMP : 0),
    }))
    .sort((a, b) => b.sortScore - a.sortScore)
    .map((row) => row.hit);

  return ranked.slice(0, limit);
}
