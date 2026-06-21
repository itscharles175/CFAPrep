import { dexieDriver } from './dexieDriver';
import { createReadThroughDriver, type ReadThroughDriver } from './fallbackDriver';
import { createDualWriteDriver, type DualWriteDriver } from './dualWriteDriver';
import { buildCutoverManifest, migrateData, type CutoverManifest, type MigrationReport } from './migrate';
import { summarizeMismatches, verifyMigration, type VerificationReport } from './integrity';
import type { StorageDriver, StorageRegistry } from './types';

export type StorageDriverName = 'dexie' | 'surrealdb';

/**
 * localStorage key holding the user's preferred storage backend.  Kept in
 * localStorage (not the storage abstraction itself) so it can be read at
 * boot before any driver initialises — same bootstrap-critical pattern the
 * theme preference uses.
 */
export const STORAGE_PREF_KEY = 'qv-storage-driver';

/**
 * Resolve a driver by name — lazy-loading + `ready()`-validating it WITHOUT
 * touching `storageRegistry.active`. Shared by `switchDriver` (which commits the
 * result) and the dry-run / dual-write paths (which need a ready target without
 * disturbing the live driver).
 *
 * The SurrealDB driver is dynamically imported on first use so its transitive
 * deps (`surrealdb` + `isows` + `ws`) stay off the default startup path.
 */
async function resolveDriver(
  name: StorageDriverName,
): Promise<{ ok: true; driver: StorageDriver } | { ok: false; error: string }> {
  let driver: StorageDriver | undefined = storageRegistry.drivers[name];

  if (!driver && name === 'surrealdb') {
    try {
      const mod = await import('./surrealDriver');
      driver = mod.surrealDriver;
      storageRegistry.drivers[name] = driver;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to load surrealdb driver: ${msg}` };
    }
  }

  if (!driver) {
    return { ok: false, error: `Unknown storage driver: ${name}` };
  }

  let isReady = false;
  try {
    isReady = await driver.ready();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Driver '${name}' ready() threw: ${msg}` };
  }

  if (!isReady) {
    return { ok: false, error: `Driver '${name}' is not ready (sidecar unreachable or init failed).` };
  }

  return { ok: true, driver };
}

/**
 * Build the SurrealDB read-through wrapper (roadmap BA4): SurrealDB primary +
 * Dexie cache, with a best-effort, non-blocking background re-warm of the Dexie
 * cache when the sidecar recovers. Dexie's raw driver is the cache — never wrap
 * it. `getStorage()` callers can't tell the wrapper from the bare driver: it
 * reports name 'surrealdb' and the full StorageDriver shape. Shared by
 * `switchDriver('surrealdb')` and a dual-write soak commit.
 */
function makeSurrealReadThrough(surreal: StorageDriver): ReadThroughDriver {
  return createReadThroughDriver(surreal, dexieDriver, {
    onRecover: () => {
      void (async () => {
        // The attempt log is append-only, so a naive re-copy would inflate the
        // cache with duplicates each resync. Clear it first so the re-warm
        // mirrors SurrealDB exactly (settings/reviewItems/mastery are
        // upsert-keyed and already idempotent under migrateData). `migrateChunks:
        // false` keeps the re-warm's historical scope — chunks aren't part of the
        // read-through cache and a corpus copy on every recovery would be heavy.
        try {
          await dexieDriver.questionResults?.clear();
        } catch {
          /* if the cache clear fails we skip the re-warm entirely below */
        }
        await migrateData(surreal, dexieDriver, { migrateChunks: false });
      })().catch(() => {
        /* cache re-warm is best-effort; a failure just leaves a staler cache
         * until the next successful resync. */
      });
    },
  });
}

/**
 * Singleton registry.  Dexie is always the default active driver.
 * The SurrealDB driver is lazy-loaded (dynamic import) the first time the
 * caller explicitly requests a switch, so the dormant SurrealDB client (and
 * its `isows`/`ws` transitive deps) never load in the default startup path
 * or in tests that don't exercise it.
 */
export const storageRegistry: StorageRegistry = {
  active: dexieDriver,
  drivers: {
    dexie: dexieDriver,
    // surrealdb is lazily populated by switchDriver('surrealdb').
  },

  async switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }> {
    const resolved = await resolveDriver(name);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    // For SurrealDB, install the read-through fallback wrapper so a sidecar
    // crash keeps reads available off the Dexie cache (roadmap BA4).
    this.active = name === 'surrealdb' ? makeSurrealReadThrough(resolved.driver) : resolved.driver;
    return { ok: true };
  },
};

/**
 * Returns the currently active `StorageDriver`.
 *
 * Usage (post-Phase-2 migration):
 *   `await getStorage().settings.put({ key, value, updatedAt })`
 */
export function getStorage(): StorageDriver {
  return storageRegistry.active;
}

/** Name of the currently active storage driver. */
export function getActiveDriverName(): StorageDriverName {
  return storageRegistry.active.name;
}

/**
 * True when the active driver is the SurrealDB read-through wrapper AND it is
 * currently serving reads from the Dexie cache (i.e. the sidecar is unreachable
 * and the fallback is engaged).  Always false for the plain Dexie config and
 * while SurrealDB is healthy.  Read-only inspection helper for the health UI;
 * does not change the active driver.
 */
export function isStorageDegraded(): boolean {
  const active = storageRegistry.active as Partial<ReadThroughDriver>;
  return active.isReadThrough === true && active.degraded === true;
}

/** Attempt to switch to the SurrealDB sidecar driver. */
export async function switchToSurreal(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('surrealdb');
}

/** Roll back to the Dexie driver. Always succeeds. */
export async function switchToDexie(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('dexie');
}

/** Read the persisted backend preference (defaults to 'dexie'). */
export function getStoredStoragePreference(): StorageDriverName {
  try {
    if (typeof localStorage === 'undefined') return 'dexie';
    return localStorage.getItem(STORAGE_PREF_KEY) === 'surrealdb' ? 'surrealdb' : 'dexie';
  } catch {
    return 'dexie';
  }
}

/** Persist the backend preference so it survives reloads. */
export function setStoredStoragePreference(name: StorageDriverName): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_PREF_KEY, name);
  } catch {
    /* private-mode / quota — preference just won't persist */
  }
}

export interface CutoverResult {
  ok: boolean;
  error?: string;
  /** Present when a data migration ran as part of the cutover. */
  report?: MigrationReport;
  /**
   * Present when a data migration ran AND was integrity-verified (DATA-3). On a
   * failed verification this carries the per-namespace count/hash comparison
   * that triggered the auto-rollback, so the UI can show exactly what diverged.
   */
  verification?: VerificationReport;
  /**
   * DATA-2 — the dry-run preview built before any mutation. Present whenever a
   * migration was attempted (success OR a refusal/rollback), so the UI can show
   * what would have moved and, on a refusal, exactly which target tables blocked
   * it.
   */
  manifest?: CutoverManifest;
  /** True when the target was already active (no-op). */
  alreadyActive?: boolean;
}

/**
 * Switch the active driver AND migrate existing data into it.
 *
 * Order of operations (safe against a half-failed migration):
 *   1. Capture the current (source) driver.
 *   2. `switchDriver(name)` — lazy-loads + validates `ready()` (for SurrealDB
 *      this connects to :8000; if unreachable the switch fails and active is
 *      untouched).
 *   3. Copy data source → target via {@link migrateData}.  If the copy throws,
 *      roll the active driver back to the source and surface the error.
 *   3b. DATA-3 — verify the copy preserved the data via {@link verifyMigration}
 *      (per-namespace row count + canonical-JSON SHA-256).  If ANY namespace
 *      diverged, the copy silently lost / corrupted / duplicated rows: roll the
 *      active driver back to the source, do NOT persist the preference, and
 *      return `{ ok: false, error: '…integrity check failed; rolled back…',
 *      report, verification }`.  Because StudyVault is local-first and
 *      single-copy, a corrupted cutover is unrecoverable — so a mismatch must
 *      never be persisted.
 *   4. Persist the preference so the choice survives a reload.
 *
 * `migrate: false` skips the data copy (used for rollback to Dexie, whose data
 * was never cleared, and to avoid duplicating the append-only attempt log).
 * Skipping the copy also skips verification — there is nothing to verify.
 *
 * DATA-2 — before any copy, a dry-run {@link buildCutoverManifest} runs and the
 * cutover REFUSES if the target already holds rows (which would duplicate the
 * append-only attempt log or clobber/mix target rows), returning the manifest so
 * the UI can show the blockers. Pass `force: true` to override the refusal; this
 * also clears the target attempt log first so the migration stays idempotent.
 */
export async function cutoverTo(
  name: StorageDriverName,
  { migrate = true, force = false }: { migrate?: boolean; force?: boolean } = {},
): Promise<CutoverResult> {
  const from = storageRegistry.active;
  if (from.name === name) {
    setStoredStoragePreference(name);
    return { ok: true, alreadyActive: true };
  }

  const switched = await storageRegistry.switchDriver(name);
  if (!switched.ok) return { ok: false, error: switched.error };

  const to = storageRegistry.active;
  let report: MigrationReport | undefined;
  if (migrate) {
    // DATA-2 — loss-safety dry-run BEFORE any mutation. Refuse a cutover that
    // would duplicate / clobber a non-empty target unless the caller forces it.
    let manifest: CutoverManifest;
    try {
      manifest = await buildCutoverManifest(from, to);
    } catch (err) {
      storageRegistry.active = from;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not preview the cutover (rolled back to '${from.name}'): ${msg}` };
    }

    if (!manifest.safe && !force) {
      storageRegistry.active = from;
      return {
        ok: false,
        error: `Refusing cutover to '${name}': ${manifest.blockers.join('; ')}. Re-run with force to overwrite.`,
        manifest,
      };
    }

    try {
      // `force` → overwrite: clear the target attempt log first so a forced
      // re-cutover onto a non-empty target is idempotent rather than duplicating.
      report = await migrateData(from, to, { overwrite: force });
    } catch (err) {
      // Roll back so the user is never stranded on an empty backend.
      storageRegistry.active = from;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Migration failed (rolled back to '${from.name}'): ${msg}`, manifest };
    }

    // DATA-3 — prove the copy preserved every namespace before committing to it.
    // A migrateData() that returned without throwing can still have silently
    // lost / corrupted / duplicated rows; verifyMigration() catches that via a
    // per-namespace row-count + canonical-JSON SHA-256 comparison. On any
    // mismatch we auto-roll-back and DO NOT persist the preference.
    let verification: VerificationReport;
    try {
      verification = await verifyMigration(from, to);
    } catch (err) {
      // The verifier itself failing (e.g. a read threw) is treated as a failed
      // verification: roll back rather than commit to an unproven backend.
      storageRegistry.active = from;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Migration integrity check could not run (rolled back to '${from.name}'): ${msg}`,
        report,
        manifest,
      };
    }

    if (!verification.ok) {
      storageRegistry.active = from;
      return {
        ok: false,
        error: `Migration integrity check failed; rolled back to '${from.name}' (mismatched: ${summarizeMismatches(
          verification,
        )}).`,
        report,
        verification,
        manifest,
      };
    }

    setStoredStoragePreference(name);
    return { ok: true, report, verification, manifest };
  }

  setStoredStoragePreference(name);
  return { ok: true, report };
}

/**
 * DATA-2 — dry-run preview of a cutover WITHOUT mutating anything (no switch, no
 * copy). Resolves the target driver (lazy-loading + ready-checking SurrealDB),
 * then builds the loss-safety {@link CutoverManifest}. Powers the System Health
 * "preview migration" affordance so the user sees what would move (and whether
 * it's safe) before committing.
 */
export async function previewCutover(
  name: StorageDriverName,
): Promise<{ ok: boolean; error?: string; manifest?: CutoverManifest }> {
  const from = storageRegistry.active;
  if (from.name === name) {
    return { ok: false, error: `Already on the '${name}' backend.` };
  }
  const resolved = await resolveDriver(name);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const manifest = await buildCutoverManifest(from, resolved.driver);
    return { ok: true, manifest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not preview the cutover: ${msg}` };
  }
}

/** A {@link CutoverResult} from a dual-write soak begin. */
export interface DualWriteSoakResult extends CutoverResult {
  /** True when the soak is now engaged (reads from SurrealDB, writes to both). */
  soak?: boolean;
}

/**
 * DATA-5b — begin a REVERSIBLE dual-write soak.
 *
 * Migrates Dexie → SurrealDB (integrity-verified, refuse-on-unsafe like
 * {@link cutoverTo}), then engages the {@link createDualWriteDriver} bridge:
 * reads come from SurrealDB, writes go to BOTH SurrealDB (primary) and Dexie
 * (shadow). The Dexie shadow stays continuously in sync, so the soak can be
 * aborted at any time with NO data loss. The preference is NOT persisted yet —
 * only {@link commitDualWriteSoak} makes the choice durable — so a reload during
 * the soak boots back on the safe Dexie default.
 *
 * runtime-verify-gated: requires a live :8000 SurrealDB sidecar.
 */
export async function beginDualWriteSoak(
  { force = false }: { force?: boolean } = {},
): Promise<DualWriteSoakResult> {
  const from = storageRegistry.active;
  if (from.name !== 'dexie') {
    return { ok: false, error: `Dual-write soak starts from the Dexie backend (currently '${from.name}').` };
  }

  const resolved = await resolveDriver('surrealdb');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const surreal = resolved.driver;

  let manifest: CutoverManifest;
  try {
    manifest = await buildCutoverManifest(from, surreal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not preview the soak: ${msg}` };
  }
  if (!manifest.safe && !force) {
    return {
      ok: false,
      error: `Refusing dual-write soak: ${manifest.blockers.join('; ')}. Re-run with force to overwrite.`,
      manifest,
    };
  }

  let report: MigrationReport;
  try {
    report = await migrateData(from, surreal, { overwrite: force });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Soak migration failed: ${msg}`, manifest };
  }

  let verification: VerificationReport;
  try {
    verification = await verifyMigration(from, surreal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Soak integrity check could not run: ${msg}`, report, manifest };
  }
  if (!verification.ok) {
    return {
      ok: false,
      error: `Soak integrity check failed (${summarizeMismatches(verification)}).`,
      report,
      verification,
      manifest,
    };
  }

  // Engage dual-write: SurrealDB primary, Dexie shadow. Reads from SurrealDB.
  storageRegistry.active = createDualWriteDriver(surreal, dexieDriver);
  return { ok: true, report, verification, manifest, soak: true };
}

/**
 * DATA-5b — commit a clean dual-write soak.
 *
 * Runs a final integrity check (primary vs shadow); if it passes, SurrealDB
 * becomes the normal read-through config and the Dexie shadow continues as its
 * read-through cache (its post-cutover role — nothing is discarded). Persists the
 * preference. If the check fails, stays in dual-write so the user can keep
 * soaking or abort.
 */
export async function commitDualWriteSoak(): Promise<{
  ok: boolean;
  error?: string;
  verification?: VerificationReport;
}> {
  const active = storageRegistry.active as Partial<DualWriteDriver>;
  if (active.isDualWrite !== true || !active.primary || typeof active.verify !== 'function') {
    return { ok: false, error: 'Not in a dual-write soak.' };
  }

  let verification: VerificationReport;
  try {
    verification = await active.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Soak integrity check could not run: ${msg}` };
  }
  if (!verification.ok) {
    return {
      ok: false,
      error: `Soak integrity check failed; staying in dual-write (${summarizeMismatches(verification)}).`,
      verification,
    };
  }

  storageRegistry.active = makeSurrealReadThrough(active.primary);
  setStoredStoragePreference('surrealdb');
  return { ok: true, verification };
}

/**
 * DATA-5b — abort a dual-write soak and roll back to the Dexie shadow.
 *
 * Loss-safe: before dropping the SurrealDB primary, RESYNC the Dexie shadow from
 * the primary (overwrite) so the shadow holds every soak-window write. This
 * matters because shadow writes are best-effort and non-throwing — a mid-soak
 * shadow failure (`shadowHealthy` false) leaves primary-only writes that a naive
 * flip-to-Dexie would silently drop. The primary is the source of truth during a
 * soak, so re-mirroring it into Dexie guarantees a no-loss rollback. If the
 * resync fails we KEEP the soak engaged (don't abandon the escape hatch) and
 * surface the error. Clears the preference to the safe default on success.
 */
export async function abortDualWriteSoak(): Promise<{ ok: boolean; error?: string }> {
  const active = storageRegistry.active as Partial<DualWriteDriver>;
  if (active.isDualWrite === true && active.primary && active.shadow) {
    try {
      await migrateData(active.primary, active.shadow, { overwrite: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not resync the Dexie shadow before abort (staying in dual-write): ${msg}` };
    }
    storageRegistry.active = active.shadow;
  } else {
    storageRegistry.active = dexieDriver;
  }
  setStoredStoragePreference('dexie');
  return { ok: true };
}

/** True when a dual-write soak is currently engaged. */
export function isDualWriteSoak(): boolean {
  return (storageRegistry.active as Partial<DualWriteDriver>).isDualWrite === true;
}

/** Read-only dual-write soak status for the health UI. */
export function getDualWriteSoakStatus(): {
  active: boolean;
  shadowHealthy: boolean;
  shadowErrorCount: number;
} {
  const d = storageRegistry.active as Partial<DualWriteDriver>;
  if (d.isDualWrite !== true) {
    return { active: false, shadowHealthy: true, shadowErrorCount: 0 };
  }
  return {
    active: true,
    shadowHealthy: d.shadowHealthy ?? true,
    shadowErrorCount: d.shadowErrorCount ?? 0,
  };
}
