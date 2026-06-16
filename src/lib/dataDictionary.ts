/**
 * Cross-domain data dictionary (roadmap DATA-2 + DATA-3, Wave 5 / Keystone K1).
 *
 * The single executable source of truth for the field semantics shared between
 * the two StudyVault data planes:
 *
 *   - HOST  (CFA / Quant / Excel): Dexie via the `StorageDriver`. `ReviewItem`
 *     (string id) + `QuestionResult` (append-only) + `MasterySnapshot`.
 *   - LSAT  (sidecar :8100, SQLite): `SRSCard` (int id, FK question_id) +
 *     `Attempt` + per-q_type `mastery()`.
 *
 * The two planes encode the SAME concept on DIFFERENT scales — difficulty
 * (host `foundation|intermediate|advanced` vs LSAT int 1–5), mastery (host
 * 0–100 percent vs LSAT 0.0–1.0 fraction), and identity (host strings vs LSAT
 * integers). This module pins every coercion EXPLICITLY so a cross-domain read
 * never silently mis-translates. The human-readable companion is
 * `docs/DATA-DICTIONARY.md`; the backend counterpart is
 * `services/lsat-backend/app/serializers.py`.
 *
 * Everything here is ADDITIVE and pure (no I/O except the schema-version
 * handshake fetch in §5) — it imports only TYPES from `learningTypes`, so it is
 * safe to use from any layer without pulling Dexie / drivers into the bundle.
 */
import type {
  Confidence,
  Difficulty,
  DomainId,
  MasterySnapshot,
  QuestionResult,
  ReviewItem,
} from './learningTypes';

// ---------------------------------------------------------------------------
// §5 (declared first — referenced by the handshake helpers below)
// Cross-domain contract version. Bumped ONLY when a shared field's MEANING
// changes (see docs/DATA-DICTIONARY.md §6). Deliberately distinct from the host
// Dexie `VAULT_SCHEMA_VERSION` and the LSAT SQLite `PRAGMA user_version`.
// ---------------------------------------------------------------------------
/** Version of the shared field-semantics contract this build speaks. */
export const CROSS_DOMAIN_SCHEMA_VERSION = 1;

/** All plane identifiers — the host `DomainId`s plus the LSAT sidecar plane. */
export type CrossDomainPlane = DomainId | 'lsat';

/** Reviewable/attemptable artifact kinds in a {@link CrossDomainId}. */
export type CrossDomainKind = 'review' | 'attempt' | 'question';

// ---------------------------------------------------------------------------
// §1 — Cross-domain identity
// ---------------------------------------------------------------------------

/**
 * A namespaced cross-domain id: `"<plane>:<kind>:<nativeId>"`, e.g.
 * `"lsat:card"`→`"lsat:review:4821"`, `"cfa:review:loiabc-123"`. LSAT integer
 * ids are stringified, never reinterpreted as numbers, so an id-scheme change
 * on the sidecar can't alias a host id.
 */
export type CrossDomainId = `${CrossDomainPlane}:${CrossDomainKind}:${string}`;

/** Build a namespaced cross-domain id from its parts. */
export function makeCrossDomainId(
  plane: CrossDomainPlane,
  kind: CrossDomainKind,
  nativeId: string | number,
): CrossDomainId {
  return `${plane}:${kind}:${String(nativeId)}` as CrossDomainId;
}

/** Parse a {@link CrossDomainId} back into parts, or `null` if malformed. */
export function parseCrossDomainId(
  id: string,
): { plane: CrossDomainPlane; kind: CrossDomainKind; nativeId: string } | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const [plane, kind, ...rest] = parts;
  const nativeId = rest.join(':');
  if (!nativeId) return null;
  if (plane !== 'cfa' && plane !== 'quant' && plane !== 'excel' && plane !== 'lsat') return null;
  if (kind !== 'review' && kind !== 'attempt' && kind !== 'question') return null;
  return { plane, kind, nativeId };
}

// ---------------------------------------------------------------------------
// §2 — Difficulty (host 3-bucket enum ⇄ LSAT int 1–5)
// ---------------------------------------------------------------------------

/** Clamp any value into the LSAT integer difficulty range [1, 5]. */
function clampLsatDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 3;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded;
}

/**
 * LSAT `difficulty` (int 1–5) → host {@link Difficulty}. Collapses 5 buckets
 * into 3: 1–2 → foundation, 3 → intermediate, 4–5 → advanced. Out-of-range /
 * non-numeric input defaults to the neutral middle (`intermediate`).
 */
export function lsatDifficultyToHost(difficulty: number | null | undefined): Difficulty {
  if (difficulty == null || !Number.isFinite(difficulty)) return 'intermediate';
  const d = clampLsatDifficulty(difficulty);
  if (d <= 2) return 'foundation';
  if (d >= 4) return 'advanced';
  return 'intermediate';
}

/**
 * Host {@link Difficulty} → LSAT `difficulty` (int 1–5). LOSSY by design — the
 * 3-bucket host enum cannot recover the original 5-point value, so we map to the
 * bucket MIDPOINT (foundation→2, intermediate→3, advanced→4) to minimize
 * round-trip drift. See docs/DATA-DICTIONARY.md §2.
 */
export function hostDifficultyToLsat(difficulty: Difficulty): number {
  switch (difficulty) {
    case 'foundation':
      return 2;
    case 'advanced':
      return 4;
    case 'intermediate':
    default:
      return 3;
  }
}

// ---------------------------------------------------------------------------
// §3 — Mastery (host 0–100 percent ⇄ LSAT 0.0–1.0 fraction)
// ---------------------------------------------------------------------------

/** The scale a mastery value is expressed on. */
export type MasteryScale = 'fraction' | 'percent';

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Normalize a mastery value (on either scale) to a 0..1 fraction. */
export function toMasteryFraction(value: number | null | undefined, scale: MasteryScale): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const fraction = scale === 'percent' ? value / 100 : value;
  return Math.round(clampFraction(fraction) * 100) / 100;
}

/** Convert a 0..1 mastery fraction back onto the requested scale. */
export function fromMasteryFraction(fraction: number, scale: MasteryScale): number {
  const f = clampFraction(fraction);
  if (scale === 'percent') return Math.round(f * 100);
  return Math.round(f * 100) / 100;
}

// ---------------------------------------------------------------------------
// §1–§4 — Canonical common shapes
//
// One domain-agnostic shape per concept that BOTH planes map to/from. The
// `crossId` + `domain` make every row self-describing; the coerced fields use
// the rules pinned above so a consumer never has to know which plane it came
// from.
// ---------------------------------------------------------------------------

/** A domain-agnostic review card (host `ReviewItem` ⇄ LSAT `SRSCard`). */
export interface CrossDomainReviewCard {
  crossId: CrossDomainId;
  domain: CrossDomainPlane;
  /** Underlying question id, namespaced (`<plane>:question:<nativeId>`). */
  questionCrossId: CrossDomainId;
  title: string;
  /** Bucketed difficulty (§2), normalized to the host 3-bucket enum. */
  difficulty: Difficulty;
  /** LSAT observed-accuracy re-estimate when present (§2); host leaves undefined. */
  empiricalDifficulty?: number;
  /** ISO 8601 due timestamp. */
  dueAt?: string;
  /** LSAT q_type (e.g. "Weaken") or host topic; free-text, not coerced. */
  itemType?: string;
  /** Why the card exists (LSAT `origin`: concept_gap | gap | manual | seed). */
  origin?: string;
  // LEARN-5 — leech + concept-gap unification. Identity coercion (no bucketing):
  // both planes count lapses on the same integer scale and flag a leech the same
  // way (lapses >= threshold), so these pass through verbatim. Optional — a plane
  // that doesn't track them (or a legacy row) leaves them undefined.
  /** Lapse count (Again ratings) for this card; same integer scale on both planes. */
  lapses?: number;
  /** Flagged as a leech (too many lapses) for the remediation queue. */
  leech?: boolean;
}

/** A domain-agnostic attempt (host `QuestionResult` ⇄ LSAT `Attempt`). */
export interface CrossDomainAttempt {
  crossId: CrossDomainId;
  domain: CrossDomainPlane;
  questionCrossId: CrossDomainId;
  correct: boolean;
  /** Verbatim chosen answer — letter (LSAT) or stringified index (host); NOT coerced across schemes (§4). */
  chosenAnswer?: string;
  confidence?: Confidence;
  /** Seconds spent (LSAT `time_ms / 1000`, rounded). */
  elapsedSeconds?: number;
  /** ISO 8601 timestamp. */
  createdAt?: string;
}

/** A domain-agnostic mastery reading (host `MasterySnapshot` ⇄ LSAT `mastery()`). */
export interface CrossDomainMastery {
  crossId: CrossDomainId;
  domain: CrossDomainPlane;
  /** 0..1 fraction (§3) regardless of the source scale. */
  masteryFraction: number;
  /** LSAT q_type or host objective/topic key. */
  key: string;
  attempts?: number;
}

// --- Host → canonical -------------------------------------------------------

/** Map a host {@link ReviewItem} to the canonical {@link CrossDomainReviewCard}. */
export function reviewItemToCanonical(item: ReviewItem): CrossDomainReviewCard {
  const domain = item.domain;
  return {
    crossId: makeCrossDomainId(domain, 'review', item.id),
    domain,
    questionCrossId: makeCrossDomainId(domain, 'question', item.learningObjective || item.id),
    title: item.title,
    // Host `ReviewItem` has no first-class difficulty field; it is implied by the
    // objective. We expose the neutral middle so the bucketed contract is total.
    difficulty: 'intermediate',
    dueAt: item.dueAt,
    itemType: item.topic,
    // LEARN-5 — identity coercion (no bucketing): pass leech/lapse/origin through
    // verbatim when the host row tracks them, else leave undefined.
    origin: item.origin,
    lapses: typeof item.lapses === 'number' ? item.lapses : undefined,
    leech: typeof item.leech === 'boolean' ? item.leech : undefined,
  };
}

/** Map a host {@link QuestionResult} to the canonical {@link CrossDomainAttempt}. */
export function questionResultToCanonical(
  result: QuestionResult,
  nativeId: string | number,
): CrossDomainAttempt {
  const domain = result.domain;
  return {
    crossId: makeCrossDomainId(domain, 'attempt', nativeId),
    domain,
    questionCrossId: makeCrossDomainId(domain, 'question', result.questionId),
    correct: result.correct,
    confidence: result.confidence,
    elapsedSeconds: result.elapsedSeconds,
    createdAt: result.createdAt,
  };
}

/** Map a host {@link MasterySnapshot} (0–100 percent) to canonical mastery. */
export function masterySnapshotToCanonical(snap: MasterySnapshot): CrossDomainMastery {
  return {
    crossId: makeCrossDomainId(snap.domain, 'question', snap.id),
    domain: snap.domain,
    masteryFraction: toMasteryFraction(snap.score, 'percent'),
    key: snap.learningObjective || snap.topic,
    attempts: snap.attempts,
  };
}

// --- LSAT (raw sidecar JSON) → canonical -----------------------------------
//
// The LSAT side is the permissive `LegacySuccessResponse` shape on the wire
// (no narrow response_model yet for /api/srs/due), so the raw rows are read
// defensively. These mirror the canonical shapes the backend serializers emit
// (`serializers.cross_domain_review_card` / `cross_domain_attempt`).

/** Raw LSAT SRS card row (subset; see `serializers.question_test_mode` + `due_cards`). */
export interface RawLsatSrsCard {
  card_id?: number | string;
  question_id?: number | string;
  stem?: string;
  prompt?: string;
  q_type?: string;
  difficulty?: number;
  empirical_difficulty?: number | null;
  origin?: string | null;
  due_date?: string;
  // LEARN-5 — leech + concept-gap unification (the `/leeches` rows carry `lapses`;
  // the SRSCard also tracks `leech`). Optional — absent on a plain due card.
  lapses?: number;
  leech?: boolean;
}

/** Raw LSAT attempt row (subset of `models.Attempt`). */
export interface RawLsatAttempt {
  id?: number | string;
  question_id?: number | string;
  is_correct?: boolean;
  chosen_answer?: string | null;
  confidence?: Confidence | null;
  time_ms?: number;
  created_at?: string;
}

function lsatTitleFrom(card: RawLsatSrsCard): string {
  const raw = (card.stem || card.prompt || '').replace(/\s+/g, ' ').trim();
  if (raw) return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
  return `LSAT item ${card.question_id ?? card.card_id ?? '?'}`;
}

/** Map a raw LSAT SRS-due card to the canonical {@link CrossDomainReviewCard}. */
export function lsatSrsCardToCanonical(card: RawLsatSrsCard): CrossDomainReviewCard {
  const nativeId = card.card_id ?? card.question_id ?? '0';
  const questionId = card.question_id ?? card.card_id ?? '0';
  return {
    crossId: makeCrossDomainId('lsat', 'review', nativeId),
    domain: 'lsat',
    questionCrossId: makeCrossDomainId('lsat', 'question', questionId),
    title: lsatTitleFrom(card),
    difficulty: lsatDifficultyToHost(card.difficulty),
    empiricalDifficulty:
      typeof card.empirical_difficulty === 'number' ? card.empirical_difficulty : undefined,
    dueAt: typeof card.due_date === 'string' ? card.due_date : undefined,
    itemType: card.q_type,
    origin: card.origin ?? undefined,
    // LEARN-5 — identity coercion: pass leech/lapse through verbatim when present.
    lapses: typeof card.lapses === 'number' ? card.lapses : undefined,
    leech: typeof card.leech === 'boolean' ? card.leech : undefined,
  };
}

/** Map a raw LSAT attempt to the canonical {@link CrossDomainAttempt}. */
export function lsatAttemptToCanonical(attempt: RawLsatAttempt): CrossDomainAttempt {
  const nativeId = attempt.id ?? '0';
  const questionId = attempt.question_id ?? '0';
  return {
    crossId: makeCrossDomainId('lsat', 'attempt', nativeId),
    domain: 'lsat',
    questionCrossId: makeCrossDomainId('lsat', 'question', questionId),
    correct: Boolean(attempt.is_correct),
    chosenAnswer: attempt.chosen_answer ?? undefined,
    confidence: attempt.confidence ?? undefined,
    elapsedSeconds:
      typeof attempt.time_ms === 'number' && attempt.time_ms > 0
        ? Math.round(attempt.time_ms / 1000)
        : undefined,
    createdAt: typeof attempt.created_at === 'string' ? attempt.created_at : undefined,
  };
}

// --- Cross-domain bridge factory -------------------------------------------
//
// Builds a `CrossDomainBridge` (the `StorageDriver.crossDomainBridge` member,
// DATA-2) over any driver's native review/attempt/mastery stores. It takes the
// minimal store SHAPE rather than importing `StorageDriver` so this module stays
// dependency-light and avoids a circular import (storage/types.ts imports the
// canonical shapes from here). A driver wires it up additively:
//
//   driver.crossDomainBridge = createCrossDomainBridge(driver);
//
// Read-only: it never writes through the native stores. The append-only host
// attempt log has no per-row id (Dexie auto-assigns one and `toArray()` carries
// it on the row as `id`), so we read the row's own `id` when present and fall
// back to the array index for a stable-within-snapshot cross id.

/** Minimal read surface the bridge factory needs from a driver. */
export interface CrossDomainSourceStores {
  reviewItems?: { toArray(): Promise<ReviewItem[]> };
  questionResults?: { toArray(): Promise<QuestionResult[]> };
  masterySnapshots?: { toArray(): Promise<MasterySnapshot[]> };
}

/** Build the DATA-2 cross-domain bridge over a driver's native host stores. */
export function createCrossDomainBridge(stores: CrossDomainSourceStores): {
  reviewCards(): Promise<CrossDomainReviewCard[]>;
  attempts(): Promise<CrossDomainAttempt[]>;
  mastery(): Promise<CrossDomainMastery[]>;
} {
  return {
    async reviewCards(): Promise<CrossDomainReviewCard[]> {
      const rows = (await stores.reviewItems?.toArray()) ?? [];
      return rows.map(reviewItemToCanonical);
    },
    async attempts(): Promise<CrossDomainAttempt[]> {
      const rows = (await stores.questionResults?.toArray()) ?? [];
      return rows.map((row, index) => {
        // `QuestionResult` carries no `id`, but the on-disk Dexie row does
        // (auto-increment). Use it when present so the cross id is stable across
        // snapshots; otherwise fall back to the array index.
        const nativeId = (row as QuestionResult & { id?: number }).id ?? index;
        return questionResultToCanonical(row, nativeId);
      });
    },
    async mastery(): Promise<CrossDomainMastery[]> {
      const rows = (await stores.masterySnapshots?.toArray()) ?? [];
      return rows.map(masterySnapshotToCanonical);
    },
  };
}

// ---------------------------------------------------------------------------
// §5 — Schema-version handshake (DATA-3)
// ---------------------------------------------------------------------------

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const SCHEMA_VERSIONS_PATH = '/api/observability/schema-versions';

/** The backend `GET /api/observability/schema-versions` body (read defensively). */
export interface RawSchemaVersionsResponse {
  cross_domain_schema_version?: number;
  db_user_version?: number;
  latest_migration_version?: number;
  host_min_supported?: number;
  generated_at?: string;
}

/** Whether the two data planes' cross-domain contracts line up. */
export type DataPlaneAlignmentStatus = 'aligned' | 'mismatch' | 'unreachable';

/** Result of the boot-time schema-version handshake. */
export interface DataPlaneAlignment {
  status: DataPlaneAlignmentStatus;
  /** The version THIS host build speaks. */
  hostVersion: number;
  /** The version the LSAT sidecar reports, or `null` when unreachable. */
  backendVersion: number | null;
  /**
   * Whether CROSS-DOMAIN writes (host→LSAT / LSAT→host) are permitted. Always
   * `false` unless `status === 'aligned'`. LOCAL (host-only Dexie) reads/writes
   * are never gated by this — only cross-domain writes.
   */
  crossDomainWritesEnabled: boolean;
  /** Human-readable explanation for the System Health "Data planes aligned" check. */
  detail: string;
}

/**
 * Compute the alignment verdict from the host's pinned version and the backend's
 * reported version. Pure — split out from the fetch so it is unit-testable.
 *
 * `aligned` requires mutual support: the host speaks `hostVersion`, the backend
 * speaks `backendVersion`, and the backend declares `host_min_supported`
 * (the oldest host contract it will accept). They are aligned iff
 * `backendVersion === hostVersion` OR (backend is newer but still accepts this
 * host, i.e. `host_min_supported <= hostVersion <= backendVersion`).
 */
export function evaluateDataPlaneAlignment(
  raw: RawSchemaVersionsResponse | null,
  hostVersion = CROSS_DOMAIN_SCHEMA_VERSION,
): DataPlaneAlignment {
  if (!raw || typeof raw.cross_domain_schema_version !== 'number') {
    return {
      status: 'unreachable',
      hostVersion,
      backendVersion: null,
      crossDomainWritesEnabled: false,
      detail:
        'LSAT sidecar did not report a cross-domain schema version — cross-domain writes are disabled (local data is unaffected).',
    };
  }
  const backendVersion = raw.cross_domain_schema_version;
  const minSupported = typeof raw.host_min_supported === 'number' ? raw.host_min_supported : backendVersion;
  const aligned =
    backendVersion === hostVersion ||
    (hostVersion >= minSupported && hostVersion <= backendVersion);
  if (aligned) {
    return {
      status: 'aligned',
      hostVersion,
      backendVersion,
      crossDomainWritesEnabled: true,
      detail:
        backendVersion === hostVersion
          ? `Both planes speak cross-domain schema v${hostVersion}.`
          : `Host v${hostVersion} is accepted by sidecar v${backendVersion} (min supported v${minSupported}).`,
    };
  }
  return {
    status: 'mismatch',
    hostVersion,
    backendVersion,
    crossDomainWritesEnabled: false,
    detail: `Cross-domain schema mismatch — host speaks v${hostVersion}, LSAT sidecar speaks v${backendVersion}. Cross-domain writes are disabled until both sides are upgraded (local data is unaffected).`,
  };
}

/**
 * Boot-time handshake: fetch the backend's schema versions and compute the
 * alignment verdict. Fully degrading — any failure (sidecar down, timeout,
 * shape drift) resolves to `status: 'unreachable'` with cross-domain writes
 * disabled, so a missing sidecar never blocks the host or throws.
 */
export async function fetchDataSchemaAlignment(
  opts: { timeoutMs?: number; hostVersion?: number } = {},
): Promise<DataPlaneAlignment> {
  const { timeoutMs = 2500, hostVersion = CROSS_DOMAIN_SCHEMA_VERSION } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${SCHEMA_VERSIONS_PATH}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return evaluateDataPlaneAlignment(null, hostVersion);
    const raw = (await res.json()) as RawSchemaVersionsResponse;
    return evaluateDataPlaneAlignment(raw, hostVersion);
  } catch {
    return evaluateDataPlaneAlignment(null, hostVersion);
  } finally {
    clearTimeout(timer);
  }
}
