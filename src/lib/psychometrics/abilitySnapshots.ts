/**
 * PSY-11 — host-plane ability snapshots + calibration residuals.
 *
 * Persists a small, append-only log of the user's ability estimate at the end of
 * each study/CAT session, plus the calibration mapping that produced it, so the
 * forecast-attribution (PSY-3) and explainable-recommendation (PSY-5) layers can
 * decompose change OVER TIME (theta deltas, drift, residuals) instead of only
 * snapshotting "now".
 *
 * STORAGE: this uses the DATA-1 Phase-1 generic keyed-table primitive,
 * `getStorage().table('abilitySnapshots')`, rather than editing the StorageDriver
 * interface or the Dexie schema. The 'abilitySnapshots' store is NOT (yet)
 * declared in the host Dexie schema (progressStore.ts, which this slice does not
 * own), so on the Dexie backend `table('abilitySnapshots')` access can throw an
 * "unknown table" error. That is treated EXACTLY like an unreachable backend:
 * every operation is wrapped so it DEGRADES GRACEFULLY — reads resolve to `[]` /
 * `null`, writes resolve to `false` — and NEVER throws on the no-store / no-network
 * path. When a future schema bump registers the store (or the SurrealDB driver is
 * active, which provisions tables on demand), the same code path persists for real
 * with no changes here.
 *
 * A one-line wiring note for whoever bumps the schema:
 *   add `abilitySnapshots: 'at, modelVersion'` (or `++id, at, modelVersion`) to the
 *   next `db.version(N).stores({...})` block in progressStore.ts and these writes
 *   start persisting on Dexie too.
 *
 * Everything is offline + deterministic given an injected table (tests pass an
 * in-memory KeyedTable; production reads `getStorage().table(...)`).
 */

import type { KeyedTable } from '../storage/types';
import { getStorage } from '../storage';
import type { AbilityDomain } from '../learningTypes';

/** Storage table name for the host-plane ability snapshot log (DATA-1 table()). */
export const ABILITY_SNAPSHOTS_TABLE = 'abilitySnapshots';

/** Bump when the snapshot's calibration model / mapping semantics change. */
export const ABILITY_MODEL_VERSION = 'host-cat-eap-1';

/**
 * One persisted ability snapshot. `theta` + `uncertainty` come straight from the
 * EAP estimator (cat.ts); `difficultyMapping` records HOW empirical difficulty was
 * mapped onto the theta scale for this snapshot so a later read can reconstruct /
 * audit the calibration that produced `theta`.
 */
export interface AbilitySnapshot {
  /** Stable key (ISO timestamp + domain). Primary key on the keyed table. */
  id: string;
  /** Which ability plane this snapshot is for (host domain or 'lsat'). */
  domain: AbilityDomain;
  /** EAP ability estimate at session end. */
  theta: number;
  /** Posterior SD (the EAP standard error) — the ability uncertainty. */
  uncertainty: number;
  /**
   * The difficulty calibration used to produce `theta`: the (b on the theta scale,
   * empiricalDifficulty in [0,1]) pairs for the administered items, plus the model
   * tag. Kept compact — this is an audit trail, not the full item bank.
   */
  difficultyMapping: {
    model: string;
    items: Array<{ id: string; b: number; empiricalDifficulty: number }>;
  };
  /** Calibration residuals: observed-correct minus model-expected per item. */
  calibrationResiduals: Array<{ id: string; observed: number; expected: number; residual: number }>;
  /** Snapshot model version (see {@link ABILITY_MODEL_VERSION}). */
  modelVersion: string;
  /** ISO timestamp the snapshot was recorded. */
  at: string;
}

/**
 * Lazily resolve the keyed table, returning `null` (never throwing) when the
 * backend doesn't expose `table()` OR the named store isn't registered. The
 * Dexie driver builds the wrapper eagerly but defers `db.table(name)` to the first
 * operation, so a missing store surfaces as a rejected promise inside the op — the
 * per-op try/catch below handles that. SurrealDB provisions tables on demand.
 */
function resolveTable(injected?: KeyedTable<AbilitySnapshot>): KeyedTable<AbilitySnapshot> | null {
  if (injected) return injected;
  try {
    const storage = getStorage();
    if (typeof storage.table !== 'function') return null;
    return storage.table<AbilitySnapshot>(ABILITY_SNAPSHOTS_TABLE);
  } catch {
    return null;
  }
}

/** Deterministic snapshot id from timestamp + domain. */
export function abilitySnapshotId(domain: AbilityDomain, at: string): string {
  return `${domain}::${at}`;
}

export interface RecordAbilitySnapshotInput {
  domain: AbilityDomain;
  /** EAP ability estimate (cat.ts theta). */
  theta: number;
  /** EAP standard error (cat.ts se). */
  uncertainty: number;
  /** The 2PL difficulty mapping used (id + b + empiricalDifficulty per item). */
  difficultyMapping: AbilitySnapshot['difficultyMapping']['items'];
  /** Per-item calibration residuals (observed vs model-expected). */
  calibrationResiduals?: AbilitySnapshot['calibrationResiduals'];
  /** Recording time. Defaults to now; tests pin it. */
  at?: string;
  /** Override the persisted model version (tests). */
  modelVersion?: string;
}

/**
 * Build an {@link AbilitySnapshot} from a session's final estimate + calibration.
 * Pure — no I/O — so it's independently testable and reusable by the persistence
 * path below.
 */
export function buildAbilitySnapshot(input: RecordAbilitySnapshotInput): AbilitySnapshot {
  const at = input.at ?? new Date().toISOString();
  return {
    id: abilitySnapshotId(input.domain, at),
    domain: input.domain,
    theta: input.theta,
    uncertainty: input.uncertainty,
    difficultyMapping: {
      model: input.modelVersion ?? ABILITY_MODEL_VERSION,
      items: input.difficultyMapping,
    },
    calibrationResiduals: input.calibrationResiduals ?? [],
    modelVersion: input.modelVersion ?? ABILITY_MODEL_VERSION,
    at,
  };
}

/**
 * Persist an ability snapshot at session end. Returns `true` when the write
 * landed, `false` when the store was unavailable (degraded). NEVER throws.
 */
export async function recordAbilitySnapshot(
  input: RecordAbilitySnapshotInput,
  injected?: KeyedTable<AbilitySnapshot>,
): Promise<boolean> {
  const table = resolveTable(injected);
  if (!table) return false;
  const snapshot = buildAbilitySnapshot(input);
  try {
    await table.put(snapshot);
    return true;
  } catch {
    // Unknown store on Dexie / unreachable sidecar — degrade silently.
    return false;
  }
}

/**
 * Read all persisted snapshots (oldest → newest by `at`), optionally filtered to a
 * domain. Resolves to `[]` when the store is unavailable. NEVER throws.
 */
export async function readAbilitySnapshots(
  domain?: AbilityDomain,
  injected?: KeyedTable<AbilitySnapshot>,
): Promise<AbilitySnapshot[]> {
  const table = resolveTable(injected);
  if (!table) return [];
  try {
    const rows = await table.toArray();
    const filtered = domain ? rows.filter((r) => r.domain === domain) : rows;
    return filtered.sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

/**
 * Read the most-recent snapshot for a domain, or `null` when none / unavailable.
 * NEVER throws.
 */
export async function readLatestAbilitySnapshot(
  domain: AbilityDomain,
  injected?: KeyedTable<AbilitySnapshot>,
): Promise<AbilitySnapshot | null> {
  const rows = await readAbilitySnapshots(domain, injected);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Compute per-item calibration residuals (observed correctness minus the model's
 * expected probability) for the items in a session. Pure helper used at record
 * time AND independently testable. `expected` is the 2PL probability the model
 * assigned; `observed` is 1/0. A positive residual = the user did better than the
 * calibration predicted (the item was easier for them than its difficulty implies).
 */
export function computeCalibrationResiduals(
  items: Array<{ id: string; correct: boolean; expected: number }>,
): AbilitySnapshot['calibrationResiduals'] {
  return items.map((it) => {
    const observed = it.correct ? 1 : 0;
    return {
      id: it.id,
      observed,
      expected: it.expected,
      residual: Math.round((observed - it.expected) * 1000) / 1000,
    };
  });
}
