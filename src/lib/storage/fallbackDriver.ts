import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  ChunkStore,
  KeyedTable,
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  SourceChunkInput,
  StorageDriver,
  StorageSettingRow,
  StorageTransactionScope,
} from './types';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';

/**
 * Read-through fallback wrapper (roadmap BA4).
 *
 * Wraps a `primary` driver (the SurrealDB sidecar) so the app survives a
 * SurrealDB crash:
 *
 *   - READS (`get` / `toArray` / `byTopic` / `search`): try the primary first.
 *     If it throws — sidecar down, connection reset, timeout — transparently
 *     serve the cached read from the `fallback` Dexie driver, which holds the
 *     data copied across at cutover.  Read availability is preserved through an
 *     outage with no caller changes.
 *
 *   - WRITES (`put` / `add` / `bulkPut` / `bulkAdd` / `upsert` / `bulkUpsert` /
 *     `delete` / `deleteByDocument` / `bulkDelete` / `clear`): route to the
 *     primary ONLY.  A write is deliberately *not* diverted to the Dexie cache
 *     during an outage: silently writing to Dexie alone would diverge the two
 *     stores and the write would be lost the moment SurrealDB recovers and
 *     reads re-point to it.  Instead the primary's error surfaces to the caller
 *     so the existing per-call semantics (retry / surface / queue) apply — the
 *     same behaviour callers already see today when SurrealDB is the active
 *     driver and a write fails.  Read availability, not write availability, is
 *     the BA4 guarantee.
 *
 * The wrapper reports the primary's `name` and the full `StorageDriver` shape,
 * so `getStorage()` / `getActiveDriverName()` callers cannot tell it apart from
 * the bare SurrealDB driver.
 *
 * Recovery: every primary-read failure flips the wrapper into a degraded state
 * and arms a best-effort, non-blocking background probe.  When `primary.ready()`
 * succeeds again the wrapper calls the supplied `onRecover` hook (the registry
 * re-points reads to SurrealDB via the existing cutover path) and clears the
 * degraded flag.  All of this is fire-and-forget — it never blocks a read.
 */

/** Tunables for the recovery probe.  Exposed for tests; defaults are sane. */
export interface FallbackDriverOptions {
  /** Called (best-effort) once the primary becomes reachable again. */
  onRecover?: () => void | Promise<void>;
  /** Called whenever a read first falls back to the cache (for telemetry). */
  onDegrade?: (err: unknown) => void;
  /** Interval between recovery probes while degraded (ms). Default 5000. */
  probeIntervalMs?: number;
  /**
   * Scheduler for the recovery probe.  Defaults to `setTimeout`; tests inject a
   * synchronous/manual scheduler so they don't depend on wall-clock time.
   */
  scheduleProbe?: (fn: () => void, delayMs: number) => void;
}

const DEFAULT_PROBE_INTERVAL_MS = 5000;

/**
 * The transparent read-through driver.  Extends {@link StorageDriver} with a
 * couple of read-only inspection fields so the registry / health UI can tell
 * whether the fallback is currently engaged without reaching into internals.
 */
export interface ReadThroughDriver extends StorageDriver {
  /** Marker so callers can detect (and avoid double-wrapping) this wrapper. */
  readonly isReadThrough: true;
  /** True while reads are being served from the Dexie cache (primary down). */
  readonly degraded: boolean;
  /** The wrapped primary (SurrealDB) driver. */
  readonly primary: StorageDriver;
  /** The cache (Dexie) driver reads fall back to. */
  readonly fallback: StorageDriver;
}

export function createReadThroughDriver(
  primary: StorageDriver,
  fallback: StorageDriver,
  options: FallbackDriverOptions = {},
): ReadThroughDriver {
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const schedule = options.scheduleProbe ?? ((fn, delayMs) => {
    setTimeout(fn, delayMs);
  });

  let degraded = false;
  /** Guards against arming more than one probe loop at a time. */
  let probeArmed = false;

  /** Enter the degraded state and arm a single best-effort recovery probe. */
  function markDegraded(err: unknown): void {
    if (!degraded) {
      degraded = true;
      try {
        options.onDegrade?.(err);
      } catch {
        /* telemetry hook must never break a read */
      }
    }
    armRecoveryProbe();
  }

  function armRecoveryProbe(): void {
    if (probeArmed) return;
    probeArmed = true;
    schedule(runRecoveryProbe, probeIntervalMs);
  }

  /**
   * Best-effort, non-blocking recovery check.  If the primary answers `ready()`
   * we clear the degraded flag and notify the registry; otherwise we re-arm.
   * Never throws — failures just re-schedule another probe.
   */
  async function runRecoveryProbe(): Promise<void> {
    probeArmed = false;
    if (!degraded) return;

    let reachable = false;
    try {
      reachable = await primary.ready();
    } catch {
      reachable = false;
    }

    if (reachable) {
      degraded = false;
      try {
        await options.onRecover?.();
      } catch {
        /* recovery is best-effort — a failing hook leaves us un-degraded but
         * still pointing reads at the (now healthy) primary, which is fine. */
      }
    } else {
      // Still down — re-arm for the next interval.
      armRecoveryProbe();
    }
  }

  /**
   * Run a primary read; on failure, mark degraded and serve from the cache.
   * `cacheRead` is only invoked on the error path, so the happy path never
   * touches Dexie.
   */
  async function readThrough<T>(
    primaryRead: () => Promise<T>,
    cacheRead: () => Promise<T>,
  ): Promise<T> {
    try {
      const value = await primaryRead();
      // A successful read means the primary is reachable again.  If we were
      // degraded, opportunistically clear the flag and let the probe (or the
      // next explicit cutover) re-point reads — but keep serving from primary
      // immediately since this very call already succeeded against it.
      if (degraded) {
        degraded = false;
        try {
          options.onRecover?.();
        } catch {
          /* best-effort */
        }
      }
      return value;
    } catch (err) {
      markDegraded(err);
      return cacheRead();
    }
  }

  // -------------------------------------------------------------------------
  // settings — get/toArray fall back to cache; mutations stay on primary.
  // -------------------------------------------------------------------------
  const settings: StorageDriver['settings'] = {
    get(key: string): Promise<StorageSettingRow | undefined> {
      return readThrough(
        () => primary.settings.get(key),
        () => fallback.settings.get(key),
      );
    },
    toArray(): Promise<StorageSettingRow[]> {
      return readThrough(
        () => primary.settings.toArray(),
        () => fallback.settings.toArray(),
      );
    },
    put(row: StorageSettingRow): Promise<void> {
      return primary.settings.put(row);
    },
    delete(key: string): Promise<void> {
      return primary.settings.delete(key);
    },
    bulkDelete(keys: string[]): Promise<void> {
      return primary.settings.bulkDelete(keys);
    },
    clear(): Promise<void> {
      return primary.settings.clear();
    },
  };

  // -------------------------------------------------------------------------
  // chunks — search falls back to cache; upserts/deletes stay on primary.
  // Only wrapped when BOTH drivers expose a chunk store (they always do today).
  // -------------------------------------------------------------------------
  let chunks: ChunkStore | undefined;
  if (primary.chunks && fallback.chunks) {
    const p = primary.chunks;
    const f = fallback.chunks;
    chunks = {
      search(opts: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
        return readThrough(
          () => p.search(opts),
          () => f.search(opts),
        );
      },
      upsert(chunk: SourceChunkInput): Promise<void> {
        return p.upsert(chunk);
      },
      bulkUpsert(input: SourceChunkInput[]): Promise<void> {
        return p.bulkUpsert(input);
      },
      deleteByDocument(documentId: string): Promise<void> {
        return p.deleteByDocument(documentId);
      },
    };
  }

  // -------------------------------------------------------------------------
  // reviewItems — get/toArray fall back; mutations stay on primary.
  // -------------------------------------------------------------------------
  let reviewItems: ReviewItemStore | undefined;
  if (primary.reviewItems && fallback.reviewItems) {
    const p = primary.reviewItems;
    const f = fallback.reviewItems;
    reviewItems = {
      get(id: string): Promise<ReviewItem | undefined> {
        return readThrough(
          () => p.get(id),
          () => f.get(id),
        );
      },
      toArray(): Promise<ReviewItem[]> {
        return readThrough(
          () => p.toArray(),
          () => f.toArray(),
        );
      },
      put(item: ReviewItem): Promise<void> {
        return p.put(item);
      },
      bulkPut(items: ReviewItem[]): Promise<void> {
        return p.bulkPut(items);
      },
      delete(id: string): Promise<void> {
        return p.delete(id);
      },
    };
  }

  // -------------------------------------------------------------------------
  // questionResults — toArray/byTopic fall back; add/bulkAdd/clear stay primary.
  // -------------------------------------------------------------------------
  let questionResults: QuestionResultStore | undefined;
  if (primary.questionResults && fallback.questionResults) {
    const p = primary.questionResults;
    const f = fallback.questionResults;
    questionResults = {
      toArray(): Promise<QuestionResult[]> {
        return readThrough(
          () => p.toArray(),
          () => f.toArray(),
        );
      },
      byTopic(domain: string, topic: string): Promise<QuestionResult[]> {
        return readThrough(
          () => p.byTopic(domain, topic),
          () => f.byTopic(domain, topic),
        );
      },
      add(result: QuestionResult): Promise<void> {
        return p.add(result);
      },
      bulkAdd(results: QuestionResult[]): Promise<void> {
        return p.bulkAdd(results);
      },
      clear(): Promise<void> {
        return p.clear();
      },
    };
  }

  // -------------------------------------------------------------------------
  // masterySnapshots — get/toArray fall back; put stays on primary.
  // -------------------------------------------------------------------------
  let masterySnapshots: MasterySnapshotStore | undefined;
  if (primary.masterySnapshots && fallback.masterySnapshots) {
    const p = primary.masterySnapshots;
    const f = fallback.masterySnapshots;
    masterySnapshots = {
      get(id: string): Promise<MasterySnapshot | undefined> {
        return readThrough(
          () => p.get(id),
          () => f.get(id),
        );
      },
      toArray(): Promise<MasterySnapshot[]> {
        return readThrough(
          () => p.toArray(),
          () => f.toArray(),
        );
      },
      put(snap: MasterySnapshot): Promise<void> {
        return p.put(snap);
      },
    };
  }

  // -------------------------------------------------------------------------
  // table() — the DATA-1 generic keyed-table primitive, made read-through.
  // The Phase-2 progressStore reroute calls getStorage().table(name); when
  // SurrealDB is active getStorage() returns THIS wrapper, so it must expose
  // table() too (else every rerouted call throws on cutover). Reads
  // (get/bulkGet/toArray/count/whereEquals/whereAnyOf/orderedBy) fall back to
  // the Dexie cache on a primary outage; writes (put/add/bulkPut/delete/
  // bulkDelete/clear) stay on the primary — identical semantics to the named
  // namespaces above. Only present when BOTH drivers implement table() (they
  // do as of DATA-1 Phase 1).
  // -------------------------------------------------------------------------
  let tableFn: StorageDriver['table'];
  if (primary.table && fallback.table) {
    const primaryTable = primary.table.bind(primary);
    const fallbackTable = fallback.table.bind(fallback);
    tableFn = <T,>(name: string): KeyedTable<T> => {
      const p = primaryTable<T>(name);
      const f = fallbackTable<T>(name);
      return {
        get: (key) => readThrough(() => p.get(key), () => f.get(key)),
        bulkGet: (keys) => readThrough(() => p.bulkGet(keys), () => f.bulkGet(keys)),
        toArray: () => readThrough(() => p.toArray(), () => f.toArray()),
        count: () => readThrough(() => p.count(), () => f.count()),
        whereEquals: (field, value) =>
          readThrough(() => p.whereEquals(field, value), () => f.whereEquals(field, value)),
        whereAnyOf: (field, values) =>
          readThrough(() => p.whereAnyOf(field, values), () => f.whereAnyOf(field, values)),
        orderedBy: (field, opts) =>
          readThrough(() => p.orderedBy(field, opts), () => f.orderedBy(field, opts)),
        // Writes stay on the primary only (BA4: read availability, not write).
        put: (row) => p.put(row),
        bulkPut: (rows) => p.bulkPut(rows),
        add: (row) => p.add(row),
        delete: (key) => p.delete(key),
        bulkDelete: (keys) => p.bulkDelete(keys),
        clear: () => p.clear(),
      };
    };
  }

  // -------------------------------------------------------------------------
  // transaction() — the DATA-1 Phase-3 atomic-batch primitive. A transaction is
  // a WRITE boundary, so per BA4 (read availability, not write availability) it
  // routes to the PRIMARY ONLY — never to the Dexie cache. Diverting an atomic
  // batch to the cache during an outage would diverge the two stores exactly
  // like the single-op writes above. The primary's error surfaces to the caller.
  // Only present when the primary implements transaction() (it does as of P3).
  // -------------------------------------------------------------------------
  let transactionFn: StorageDriver['transaction'];
  if (primary.transaction) {
    const primaryTransaction = primary.transaction.bind(primary);
    transactionFn = <T,>(
      tables: string[],
      mode: 'rw',
      fn: (tx: StorageTransactionScope) => Promise<T>,
    ): Promise<T> => primaryTransaction(tables, mode, fn);
  }

  const wrapper: ReadThroughDriver = {
    name: primary.name,
    isReadThrough: true,
    get degraded() {
      return degraded;
    },
    primary,
    fallback,

    // `ready()` reflects the primary — that's what callers / the registry probe
    // when deciding whether SurrealDB is live.  A successful ready() also clears
    // any lingering degraded flag.
    async ready(): Promise<boolean> {
      let ok = false;
      try {
        ok = await primary.ready();
      } catch {
        ok = false;
      }
      if (ok && degraded) {
        degraded = false;
      }
      return ok;
    },

    settings,
    chunks,
    reviewItems,
    questionResults,
    masterySnapshots,
    table: tableFn,
    transaction: transactionFn,
  };

  return wrapper;
}
