/**
 * NAV-1 — durable Study Trail + cross-restart session restore.
 *
 * The unified shell forgets WHERE the user was the moment the app restarts: a
 * relaunch (or a crash, or an OS reboot of the Electron window) drops them on the
 * default route with no breadcrumb back to the lesson / drill / passage they had
 * open. This module records a small, append-only trail of study CONTEXT
 * (route + domain + query-state + a resume handle) so the shell can offer
 * "resume where you left off" after a restart.
 *
 * TWO persistence tiers, by durability need:
 *
 *   1. TRAIL (history)   — the last-N visited study contexts. Persisted via the
 *      DATA-1 generic keyed-table primitive, `getStorage().table('studyTrail')`.
 *      The 'studyTrail' store is NOT (yet) declared in the host Dexie schema
 *      (progressStore.ts, which this slice does not own), so on the Dexie backend
 *      `table('studyTrail')` access can throw "unknown table". That is treated
 *      EXACTLY like an unreachable backend — every op DEGRADES GRACEFULLY (reads
 *      → [], writes → false) and NEVER throws on the no-store path. A future
 *      schema bump that registers the store starts persisting the trail for real
 *      with zero changes here (wiring note below).
 *
 *   2. RESUME HANDLE     — the single "most recent context" pointer. Kept in
 *      localStorage (NOT the storage abstraction) so it is readable at BOOT,
 *      synchronously, before any async Dexie/Surreal driver initialises — the
 *      same bootstrap-critical pattern the theme + storage-driver preferences
 *      use. This is what powers the instant "resume" affordance on first paint.
 *
 * Wiring note for whoever bumps the host Dexie schema (progressStore.ts):
 *   add `studyTrail: 'id, recordedAt'` to the next `db.version(N).stores({...})`
 *   block and the trail writes start persisting on Dexie too.
 *
 * Everything is OFFLINE + deterministic given an injected table + clock. No
 * cloud, ever. Tests pass an in-memory KeyedTable + a stub localStorage.
 */

import type { KeyedTable } from './storage/types';
import { getStorage } from './storage';

/** Storage table name for the durable study trail (DATA-1 table()). */
export const STUDY_TRAIL_TABLE = 'studyTrail';

/** localStorage key for the lightweight, boot-readable resume handle. */
export const RESUME_HANDLE_KEY = 'qv-resume-handle';

/** How many trail entries to retain (oldest pruned past this). */
export const STUDY_TRAIL_LIMIT = 50;

/** A study plane the trail can be scoped to (host domains + the LSAT plane). */
export type StudyTrailDomain = 'cfa' | 'quant' | 'excel' | 'lsat' | 'host';

/**
 * One recorded study context. `route` + `domain` + `queryState` capture WHERE
 * the user was; `resumeHandle` is an opaque, plane-defined token the destination
 * can use to restore deeper state (e.g. a mock-section id, a passage cursor) —
 * the trail does not interpret it.
 */
export interface StudyTrailEntry {
  /** Stable key: ISO timestamp (sort + dedupe anchor). Primary key. */
  id: string;
  /** Which plane this context belongs to. */
  domain: StudyTrailDomain;
  /** App route (path) the user was on, e.g. "/cfa/lesson/abc" or "/lsat/srs". */
  route: string;
  /** Short human label for the resume affordance, e.g. "Ethics — Lesson 3". */
  label: string;
  /** Serialized query/UI state (search params, active tab, filter) — opaque map. */
  queryState?: Record<string, string>;
  /** Opaque resume token the destination interprets (mock id, cursor, …). */
  resumeHandle?: string;
  /** ISO timestamp the context was recorded. */
  recordedAt: string;
}

/** The boot-readable resume pointer (a subset of the latest entry). */
export interface ResumeHandle {
  domain: StudyTrailDomain;
  route: string;
  label: string;
  queryState?: Record<string, string>;
  resumeHandle?: string;
  recordedAt: string;
}

/** Input to {@link recordStudyContext} — `recordedAt`/`id` default to now. */
export interface RecordStudyContextInput {
  domain: StudyTrailDomain;
  route: string;
  label: string;
  queryState?: Record<string, string>;
  resumeHandle?: string;
  /** Recording time. Defaults to now; tests pin it. */
  recordedAt?: string;
}

/**
 * Lazily resolve the keyed table, returning `null` (never throwing) when the
 * backend doesn't expose `table()` OR the named store isn't registered. Mirrors
 * the abilitySnapshots pattern exactly: the Dexie driver defers `db.table(name)`
 * to the first op, so a missing store surfaces as a rejected promise inside the
 * op — the per-op try/catch handles that.
 */
function resolveTable(injected?: KeyedTable<StudyTrailEntry>): KeyedTable<StudyTrailEntry> | null {
  if (injected) return injected;
  try {
    const storage = getStorage();
    if (typeof storage.table !== 'function') return null;
    return storage.table<StudyTrailEntry>(STUDY_TRAIL_TABLE);
  } catch {
    return null;
  }
}

/** Safe localStorage access — undefined in non-browser / private-mode contexts. */
function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Build a {@link StudyTrailEntry} from an input. Pure — no I/O. */
export function buildStudyTrailEntry(input: RecordStudyContextInput): StudyTrailEntry {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  return {
    id: recordedAt,
    domain: input.domain,
    route: input.route,
    label: input.label,
    queryState: input.queryState,
    resumeHandle: input.resumeHandle,
    recordedAt,
  };
}

/** Project a trail entry onto the boot-readable {@link ResumeHandle}. */
export function entryToResumeHandle(entry: StudyTrailEntry): ResumeHandle {
  return {
    domain: entry.domain,
    route: entry.route,
    label: entry.label,
    queryState: entry.queryState,
    resumeHandle: entry.resumeHandle,
    recordedAt: entry.recordedAt,
  };
}

/**
 * Persist the lightweight resume handle to localStorage. NEVER throws (quota /
 * private-mode just means it won't persist). Returns whether it was written.
 */
export function writeResumeHandle(handle: ResumeHandle): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(RESUME_HANDLE_KEY, JSON.stringify(handle));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the boot-readable resume handle synchronously from localStorage. Returns
 * `null` when absent / malformed / unavailable. NEVER throws — safe to call on
 * first paint before any storage driver is up.
 */
export function readResumeHandle(): ResumeHandle | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(RESUME_HANDLE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const h = parsed as Partial<ResumeHandle>;
    if (typeof h.route !== 'string' || typeof h.domain !== 'string') return null;
    return {
      domain: h.domain as StudyTrailDomain,
      route: h.route,
      label: typeof h.label === 'string' ? h.label : h.route,
      queryState:
        h.queryState && typeof h.queryState === 'object' ? (h.queryState as Record<string, string>) : undefined,
      resumeHandle: typeof h.resumeHandle === 'string' ? h.resumeHandle : undefined,
      recordedAt: typeof h.recordedAt === 'string' ? h.recordedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Clear the resume handle (e.g. once the user has resumed / dismissed it). */
export function clearResumeHandle(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(RESUME_HANDLE_KEY);
  } catch {
    /* private-mode / quota — nothing to clear */
  }
}

/**
 * Record a study context: write the durable trail entry (best-effort, degrades)
 * AND always update the boot-readable resume handle (localStorage). The resume
 * handle is the load-bearing affordance, so it is written even when the durable
 * trail store is unavailable. Returns `{ trailed, resumed }` so a caller can
 * tell whether the durable write landed. NEVER throws.
 */
export async function recordStudyContext(
  input: RecordStudyContextInput,
  injected?: KeyedTable<StudyTrailEntry>,
): Promise<{ trailed: boolean; resumed: boolean }> {
  const entry = buildStudyTrailEntry(input);
  const resumed = writeResumeHandle(entryToResumeHandle(entry));

  const table = resolveTable(injected);
  if (!table) return { trailed: false, resumed };
  try {
    await table.put(entry);
    // Best-effort prune of the oldest entries past the retention cap. A prune
    // failure must not fail the record, so it is swallowed independently.
    try {
      const all = await table.toArray();
      if (all.length > STUDY_TRAIL_LIMIT) {
        const sorted = [...all].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const excess = sorted.slice(0, sorted.length - STUDY_TRAIL_LIMIT);
        await table.bulkDelete(excess.map((e) => e.id));
      }
    } catch {
      /* prune is best-effort */
    }
    return { trailed: true, resumed };
  } catch {
    // Unknown store on Dexie / unreachable sidecar — degrade silently.
    return { trailed: false, resumed };
  }
}

/**
 * Read the durable trail, newest → oldest, optionally filtered to a domain and
 * capped. Resolves to `[]` when the store is unavailable. NEVER throws.
 */
export async function readStudyTrail(
  opts: { domain?: StudyTrailDomain; limit?: number } = {},
  injected?: KeyedTable<StudyTrailEntry>,
): Promise<StudyTrailEntry[]> {
  const table = resolveTable(injected);
  if (!table) return [];
  try {
    const rows = await table.toArray();
    const filtered = opts.domain ? rows.filter((r) => r.domain === opts.domain) : rows;
    const sorted = filtered.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return typeof opts.limit === 'number' ? sorted.slice(0, Math.max(0, opts.limit)) : sorted;
  } catch {
    return [];
  }
}

/**
 * Resolve the best "resume where you left off" target. Prefers the durable trail
 * (richer, survives if the resume handle was cleared independently) and falls
 * back to the boot-readable localStorage handle when the trail store is
 * unavailable. Returns `null` when there is nothing to resume. NEVER throws.
 */
export async function getResumeTarget(injected?: KeyedTable<StudyTrailEntry>): Promise<ResumeHandle | null> {
  const trail = await readStudyTrail({ limit: 1 }, injected);
  if (trail.length) return entryToResumeHandle(trail[0]);
  return readResumeHandle();
}
