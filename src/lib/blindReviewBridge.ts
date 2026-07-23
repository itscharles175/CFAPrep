/**
 * ANL-3 — host-side client for the cross-domain BLIND-REVIEW gap (careless vs
 * concept).
 *
 * The LSAT backend's 2x2 blind-review routing (timed_ok / timing_problem /
 * concept_gap / lucky) and its accuracy-by-type gap are LSAT-native. ANL-3 lifts
 * them to a cross-domain read so the host (CFA/Quant/Excel) can see the SAME
 * careless-vs-concept split next to LSAT's. The sidecar exposes it on
 * `GET /api/analytics/blind-review-gap?domain=` (the backend merges LSAT
 * `Attempt(br_answer/br_correct)` with host blind-review attempts mirrored
 * read-only via DATA-4a's `HostProgressSnapshot`).
 *
 * This is a SEPARATE, additive file (it does not touch `lsatBackend.ts` /
 * `lsatAnalyticsBridge.ts`): it owns the blind-review boundary only, with the
 * same fully-degrading timeout/AbortController pattern — any failure (sidecar
 * down, timeout, shape drift) resolves to `{ reachable: false, ... }` so the page
 * degrades to the host-local 2x2 (computed here from Dexie) rather than throwing
 * or hanging.
 *
 * DATA-1: the `?domain=` param ships ahead of the next `api.gen.ts`
 * regeneration, so the path is a string literal for now (same precedent as
 * `studyProfileBridge.ts` / `lsatReviewBridge.ts`). Swap to the generated
 * operation once the contract is regenerated with the param.
 */
import type { paths } from '../domains/lsat/lib/api.gen';
import type { QuestionResult } from './learningTypes';
import { fetchLsatSidecarJson } from './lsatSidecarClient';

const BLIND_REVIEW_GAP_PATH = '/api/analytics/blind-review-gap' satisfies keyof paths;

/** The four 2x2 blind-review outcomes (mirrors backend `blind_review_outcome`). */
export type BlindReviewOutcome = 'timed_ok' | 'timing_problem' | 'concept_gap' | 'lucky';

/** Evidence plane for the cross-domain blind-review gap (backend `?domain=`). */
export type BlindReviewDomain = 'lsat' | 'host' | 'all' | 'cfa' | 'quant' | 'excel';

/** Count of each 2x2 outcome over a pool of attempts. */
export interface BlindReviewOutcomeCounts {
  timed_ok: number;
  timing_problem: number;
  concept_gap: number;
  lucky: number;
}

/** Per-bucket BR block (mirrors the backend `_br_block` shape). */
export interface BlindReviewBlock {
  attempts: number;
  /** Timed accuracy over attempts that have a BR pass (0..1). */
  timed_accuracy: number;
  /** Blind-Review accuracy over those same attempts (0..1). */
  br_accuracy: number;
  /** br_accuracy − timed_accuracy (positive = BR outruns timed → timing/careless). */
  gap: number;
  outcomes: BlindReviewOutcomeCounts;
  /** timed-wrong / BR-right fraction — the "careless/timing slip, not a concept gap" rate. */
  careless_rate: number;
  /** timed-wrong / BR-wrong fraction — the true concept-gap rate. */
  concept_gap_rate: number;
  /** timed-right / BR-wrong fraction — the "lucky" rate. */
  lucky_rate: number;
}

/** One per-type accuracy/gap row of the combined pool. */
export interface BlindReviewTypeRow {
  q_type: string;
  timed_accuracy: number;
  br_accuracy: number;
  gap: number;
  attempts: number;
}

/** The cross-domain blind-review gap report (mirrors `blind_review_gap_cross_domain`). */
export interface CrossDomainBlindReviewReport {
  /** True when the sidecar answered 2xx with a usable cross-domain payload. */
  reachable: boolean;
  /** The plane this report covers ('lsat' | 'host' | 'all' | a host plane). */
  domain: BlindReviewDomain;
  /** Combined-pool top-line. */
  timed_accuracy: number;
  br_accuracy: number;
  gap: number;
  outcomes: BlindReviewOutcomeCounts;
  careless_rate: number;
  concept_gap_rate: number;
  lucky_rate: number;
  by_type: BlindReviewTypeRow[];
  /** Per-type lucky rate (only types with enough BR data, backend floor = 3). */
  lucky_rate_by_type: Record<string, number>;
  /** Per-domain blocks (lsat / host) so the UI can show them side by side. */
  by_domain: { lsat: BlindReviewBlock; host: BlindReviewBlock };
  /** How many BR attempts came from each side (from the backend meta). */
  lsat_attempts: number;
  host_attempts: number;
}

// ---------------------------------------------------------------------------
// Shared 2x2 routing (pure) — mirrors backend `blind_review_outcome`.
// ---------------------------------------------------------------------------

/**
 * The 2x2 blind-review routing. With no BR grade it falls back to the timed-only
 * labels (timed_ok / concept_gap), exactly like the backend.
 */
export function blindReviewOutcome(
  timedCorrect: boolean,
  brCorrect: boolean | null | undefined,
): BlindReviewOutcome {
  if (brCorrect === null || brCorrect === undefined) {
    return timedCorrect ? 'timed_ok' : 'concept_gap';
  }
  if (timedCorrect && brCorrect) return 'timed_ok';
  if (!timedCorrect && brCorrect) return 'timing_problem';
  if (!timedCorrect && !brCorrect) return 'concept_gap';
  return 'lucky'; // timed right, BR wrong
}

function emptyOutcomes(): BlindReviewOutcomeCounts {
  return { timed_ok: 0, timing_problem: 0, concept_gap: 0, lucky: 0 };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function emptyBlock(): BlindReviewBlock {
  return {
    attempts: 0,
    timed_accuracy: 0,
    br_accuracy: 0,
    gap: 0,
    outcomes: emptyOutcomes(),
    careless_rate: 0,
    concept_gap_rate: 0,
    lucky_rate: 0,
  };
}

/**
 * Compute a blind-review block from host attempts LOCALLY (no network). Used as
 * the degraded fallback when the sidecar is unreachable, and as the host-only
 * view. Only attempts that captured a BR answer (`brAnswer != null`) contribute,
 * mirroring the backend's `a.br_answer is not None` gate.
 */
export function computeHostBlindReviewBlock(
  results: Array<Pick<QuestionResult, 'correct' | 'brAnswer' | 'brCorrect'>>,
): BlindReviewBlock {
  const withBr = results.filter((r) => r.brAnswer !== undefined && r.brAnswer !== null);
  const n = withBr.length;
  if (n === 0) return emptyBlock();

  const outcomes = emptyOutcomes();
  let timedCorrect = 0;
  let brCorrect = 0;
  for (const r of withBr) {
    if (r.correct) timedCorrect += 1;
    if (r.brCorrect) brCorrect += 1;
    outcomes[blindReviewOutcome(Boolean(r.correct), r.brCorrect ?? null)] += 1;
  }
  const timedAcc = round4(timedCorrect / n);
  const brAcc = round4(brCorrect / n);
  return {
    attempts: n,
    timed_accuracy: timedAcc,
    br_accuracy: brAcc,
    gap: round4(brAcc - timedAcc),
    outcomes,
    careless_rate: round4(outcomes.timing_problem / n),
    concept_gap_rate: round4(outcomes.concept_gap / n),
    lucky_rate: round4(outcomes.lucky / n),
  };
}

// ---------------------------------------------------------------------------
// Sidecar fetch (degrading)
// ---------------------------------------------------------------------------

async function fetchJson(
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const res = await fetchLsatSidecarJson(path, {
    timeoutMs,
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (res.reachable) return { ok: res.ok, status: res.status, data: res.data };
  return { ok: false, status: 0, error: res.error ?? 'LSAT backend unreachable' };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readOutcomes(value: unknown): BlindReviewOutcomeCounts {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    timed_ok: num(o.timed_ok),
    timing_problem: num(o.timing_problem),
    concept_gap: num(o.concept_gap),
    lucky: num(o.lucky),
  };
}

function readBlock(value: unknown): BlindReviewBlock {
  if (!value || typeof value !== 'object') return emptyBlock();
  const b = value as Record<string, unknown>;
  return {
    attempts: num(b.attempts),
    timed_accuracy: num(b.timed_accuracy),
    br_accuracy: num(b.br_accuracy),
    gap: num(b.gap),
    outcomes: readOutcomes(b.outcomes),
    careless_rate: num(b.careless_rate),
    concept_gap_rate: num(b.concept_gap_rate),
    lucky_rate: num(b.lucky_rate),
  };
}

function readTypeRows(value: unknown): BlindReviewTypeRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .filter((row) => typeof row.q_type === 'string')
    .map((row) => ({
      q_type: String(row.q_type),
      timed_accuracy: num(row.timed_accuracy),
      br_accuracy: num(row.br_accuracy),
      gap: num(row.gap),
      attempts: num(row.attempts),
    }));
}

function readLuckyByType(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** A reachable-false report carrying empty blocks (used on every failure path). */
function unreachable(domain: BlindReviewDomain): CrossDomainBlindReviewReport {
  return {
    reachable: false,
    domain,
    timed_accuracy: 0,
    br_accuracy: 0,
    gap: 0,
    outcomes: emptyOutcomes(),
    careless_rate: 0,
    concept_gap_rate: 0,
    lucky_rate: 0,
    by_type: [],
    lucky_rate_by_type: {},
    by_domain: { lsat: emptyBlock(), host: emptyBlock() },
    lsat_attempts: 0,
    host_attempts: 0,
  };
}

/**
 * Fetch the cross-domain blind-review gap from the LSAT sidecar. Never throws —
 * any failure degrades to `{ reachable: false, ... }` (empty blocks) so the
 * caller can fall back to the host-local 2x2 (`computeHostBlindReviewBlock`).
 *
 * `domain` selects the evidence plane: 'all' (default) merges LSAT + host;
 * 'lsat' / 'host' / a host plane (cfa|quant|excel) narrow it. `days` follows the
 * shared backend window convention (omit for all-time).
 */
export async function getCrossDomainBlindReviewGap(
  opts: { domain?: BlindReviewDomain; days?: number | null; timeoutMs?: number } = {},
): Promise<CrossDomainBlindReviewReport> {
  const { domain = 'all', days = null, timeoutMs = 3000 } = opts;
  const params = new URLSearchParams({ domain });
  if (typeof days === 'number' && days > 0) {
    params.set('days', String(Math.min(730, Math.round(days))));
  }
  const res = await fetchJson(`${BLIND_REVIEW_GAP_PATH}?${params.toString()}`, timeoutMs);
  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
    return unreachable(domain);
  }
  const body = res.data as Record<string, unknown>;
  const meta = body.meta && typeof body.meta === 'object' ? (body.meta as Record<string, unknown>) : {};
  const byDomain =
    body.by_domain && typeof body.by_domain === 'object'
      ? (body.by_domain as Record<string, unknown>)
      : {};
  return {
    reachable: true,
    domain,
    timed_accuracy: num(body.timed_accuracy),
    br_accuracy: num(body.br_accuracy),
    gap: num(body.gap),
    outcomes: readOutcomes(body.outcomes),
    careless_rate: num(body.careless_rate),
    concept_gap_rate: num(body.concept_gap_rate),
    lucky_rate: num(body.lucky_rate),
    by_type: readTypeRows(body.by_type),
    lucky_rate_by_type: readLuckyByType(body.lucky_rate_by_type),
    by_domain: { lsat: readBlock(byDomain.lsat), host: readBlock(byDomain.host) },
    lsat_attempts: num(meta.lsat_attempts),
    host_attempts: num(meta.host_attempts),
  };
}
