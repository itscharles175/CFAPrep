import { verifyMigration, type VerificationReport } from './integrity';
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
 * DATA-5b — dual-write strangler bridge for a REVERSIBLE SurrealDB cutover.
 *
 * The shipped cutover is a one-shot copy-then-flip: once SurrealDB is active,
 * everything written there is lost if the user rolls back to Dexie. This wrapper
 * converts that irreversible flip into a safe migration with a live escape hatch:
 *
 *   - WRITES go to the `primary` (SurrealDB) FIRST — it must succeed, and its
 *     error surfaces to the caller exactly like a normal SurrealDB write — and
 *     are then MIRRORED to the `shadow` (Dexie) best-effort. A shadow failure
 *     never breaks the app; it just flips `shadowHealthy` false (and fires
 *     `onShadowError`) so the soak can be judged unsafe to commit.
 *
 *   - READS come from the `primary` only, so the app behaves exactly as it will
 *     after the cutover commits.
 *
 * Run as a SOAK WINDOW: begin after a clean Dexie→SurrealDB migration, let real
 * traffic flow through both stores, then either {@link DualWriteDriver.verify}
 * + commit (drop the shadow, keep SurrealDB) or abort back to the Dexie shadow,
 * which holds every soak-window write — so rolling back loses nothing.
 *
 * runtime-verify-gated: the live SurrealDB side isn't exercised today (Dexie is
 * the active backend), so the cross-backend behaviour here is wire-ready but
 * unverified against a :8000 sidecar. The wrapper logic itself is unit-tested
 * with two in-memory drivers.
 *
 * NOTE on the append-only attempt log: `add`/`bulkAdd` let each backend assign
 * its own auto-id, so primary and shadow rows carry DIFFERENT ids. {@link verify}
 * compares row-set digests that include those ids, so the `questionResults`
 * comparison across heterogeneous id schemes (SurrealDB record id vs Dexie ++id)
 * can report a benign mismatch — the SAME runtime-gated limitation `cutoverTo`'s
 * integrity check has. The keyed namespaces (settings/reviewItems/mastery/chunks)
 * key off stable host ids and compare cleanly.
 */

/** Options for {@link createDualWriteDriver}. */
export interface DualWriteOptions {
  /** Called (best-effort) whenever a shadow write fails. Telemetry only. */
  onShadowError?: (err: unknown) => void;
}

/**
 * The dual-write driver. Extends {@link StorageDriver} with read-only inspection
 * fields + a {@link verify} so the registry / health UI can judge the soak.
 */
export interface DualWriteDriver extends StorageDriver {
  /** Marker so callers can detect (and avoid double-wrapping) this wrapper. */
  readonly isDualWrite: true;
  /** The primary (read source + first write target) — SurrealDB. */
  readonly primary: StorageDriver;
  /** The shadow (mirrored write target + rollback escape hatch) — Dexie. */
  readonly shadow: StorageDriver;
  /** False once any shadow write has failed (the soak is no longer commit-safe). */
  readonly shadowHealthy: boolean;
  /** How many shadow writes have failed during the soak. */
  readonly shadowErrorCount: number;
  /** Compare primary vs shadow (the integrity check gating a commit). */
  verify(): Promise<VerificationReport>;
}

export function createDualWriteDriver(
  primary: StorageDriver,
  shadow: StorageDriver,
  options: DualWriteOptions = {},
): DualWriteDriver {
  let shadowHealthy = true;
  let shadowErrorCount = 0;

  function recordShadowError(err: unknown): void {
    shadowHealthy = false;
    shadowErrorCount += 1;
    try {
      options.onShadowError?.(err);
    } catch {
      /* telemetry hook must never break a write */
    }
  }

  /**
   * Run a write on the primary (must succeed — its error propagates), then
   * mirror it to the shadow best-effort. Returns the primary's result.
   */
  async function dualWrite<T>(
    primaryOp: () => Promise<T>,
    shadowOp: () => Promise<unknown>,
  ): Promise<T> {
    const result = await primaryOp();
    try {
      await shadowOp();
    } catch (err) {
      recordShadowError(err);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // settings — reads from primary; writes mirrored.
  // -------------------------------------------------------------------------
  const settings: StorageDriver['settings'] = {
    get(key: string): Promise<StorageSettingRow | undefined> {
      return primary.settings.get(key);
    },
    toArray(): Promise<StorageSettingRow[]> {
      return primary.settings.toArray();
    },
    put(row: StorageSettingRow): Promise<void> {
      return dualWrite(
        () => primary.settings.put(row),
        () => shadow.settings.put(row),
      );
    },
    delete(key: string): Promise<void> {
      return dualWrite(
        () => primary.settings.delete(key),
        () => shadow.settings.delete(key),
      );
    },
    bulkDelete(keys: string[]): Promise<void> {
      return dualWrite(
        () => primary.settings.bulkDelete(keys),
        () => shadow.settings.bulkDelete(keys),
      );
    },
    clear(): Promise<void> {
      return dualWrite(
        () => primary.settings.clear(),
        () => shadow.settings.clear(),
      );
    },
  };

  // -------------------------------------------------------------------------
  // chunks — search/exportAll from primary; upserts/deletes mirrored.
  // -------------------------------------------------------------------------
  let chunks: ChunkStore | undefined;
  if (primary.chunks && shadow.chunks) {
    const p = primary.chunks;
    const s = shadow.chunks;
    chunks = {
      search(opts: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
        return p.search(opts);
      },
      upsert(chunk: SourceChunkInput): Promise<void> {
        return dualWrite(
          () => p.upsert(chunk),
          () => s.upsert(chunk),
        );
      },
      bulkUpsert(input: SourceChunkInput[]): Promise<void> {
        return dualWrite(
          () => p.bulkUpsert(input),
          () => s.bulkUpsert(input),
        );
      },
      deleteByDocument(documentId: string): Promise<void> {
        return dualWrite(
          () => p.deleteByDocument(documentId),
          () => s.deleteByDocument(documentId),
        );
      },
      ...(p.exportAll && s.exportAll
        ? { exportAll: (): Promise<SourceChunkInput[]> => p.exportAll!() }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // reviewItems — reads from primary; writes mirrored.
  // -------------------------------------------------------------------------
  let reviewItems: ReviewItemStore | undefined;
  if (primary.reviewItems && shadow.reviewItems) {
    const p = primary.reviewItems;
    const s = shadow.reviewItems;
    reviewItems = {
      get(id: string): Promise<ReviewItem | undefined> {
        return p.get(id);
      },
      toArray(): Promise<ReviewItem[]> {
        return p.toArray();
      },
      put(item: ReviewItem): Promise<void> {
        return dualWrite(
          () => p.put(item),
          () => s.put(item),
        );
      },
      bulkPut(items: ReviewItem[]): Promise<void> {
        return dualWrite(
          () => p.bulkPut(items),
          () => s.bulkPut(items),
        );
      },
      delete(id: string): Promise<void> {
        return dualWrite(
          () => p.delete(id),
          () => s.delete(id),
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // questionResults — reads from primary; add/bulkAdd/clear mirrored. See the
  // module note: each backend assigns its own auto-id, so the two logs hold the
  // same content under different ids.
  // -------------------------------------------------------------------------
  let questionResults: QuestionResultStore | undefined;
  if (primary.questionResults && shadow.questionResults) {
    const p = primary.questionResults;
    const s = shadow.questionResults;
    questionResults = {
      toArray(): Promise<QuestionResult[]> {
        return p.toArray();
      },
      byTopic(domain: string, topic: string): Promise<QuestionResult[]> {
        return p.byTopic(domain, topic);
      },
      add(result: QuestionResult): Promise<void> {
        return dualWrite(
          () => p.add(result),
          () => s.add(result),
        );
      },
      bulkAdd(results: QuestionResult[]): Promise<void> {
        return dualWrite(
          () => p.bulkAdd(results),
          () => s.bulkAdd(results),
        );
      },
      clear(): Promise<void> {
        return dualWrite(
          () => p.clear(),
          () => s.clear(),
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // masterySnapshots — reads from primary; put mirrored.
  // -------------------------------------------------------------------------
  let masterySnapshots: MasterySnapshotStore | undefined;
  if (primary.masterySnapshots && shadow.masterySnapshots) {
    const p = primary.masterySnapshots;
    const s = shadow.masterySnapshots;
    masterySnapshots = {
      get(id: string): Promise<MasterySnapshot | undefined> {
        return p.get(id);
      },
      toArray(): Promise<MasterySnapshot[]> {
        return p.toArray();
      },
      put(snap: MasterySnapshot): Promise<void> {
        return dualWrite(
          () => p.put(snap),
          () => s.put(snap),
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // table() — generic keyed-table primitive (DATA-1). Reads from primary; writes
  // mirrored. Only present when BOTH drivers implement table().
  // -------------------------------------------------------------------------
  let tableFn: StorageDriver['table'];
  if (primary.table && shadow.table) {
    const primaryTable = primary.table.bind(primary);
    const shadowTable = shadow.table.bind(shadow);
    tableFn = <T,>(name: string): KeyedTable<T> => {
      const p = primaryTable<T>(name);
      const s = shadowTable<T>(name);
      return {
        get: (key) => p.get(key),
        bulkGet: (keys) => p.bulkGet(keys),
        toArray: () => p.toArray(),
        count: () => p.count(),
        whereEquals: (field, value) => p.whereEquals(field, value),
        whereAnyOf: (field, values) => p.whereAnyOf(field, values),
        orderedBy: (field, opts) => p.orderedBy(field, opts),
        put: (row) => dualWrite(() => p.put(row), () => s.put(row)),
        bulkPut: (rows) => dualWrite(() => p.bulkPut(rows), () => s.bulkPut(rows)),
        add: (row) => dualWrite(() => p.add(row), () => s.add(row)),
        delete: (key) => dualWrite(() => p.delete(key), () => s.delete(key)),
        bulkDelete: (keys) => dualWrite(() => p.bulkDelete(keys), () => s.bulkDelete(keys)),
        clear: () => dualWrite(() => p.clear(), () => s.clear()),
      };
    };
  }

  // -------------------------------------------------------------------------
  // transaction() — atomic batch (DATA-1 Phase 3). Runs `fn` on the primary
  // (atomic, returns its result), then MIRRORS by re-running `fn` on the shadow
  // best-effort. Re-running is safe because the progressStore recorders are pure
  // functions of storage state; a primary+shadow that start identical (a clean
  // soak) stay identical, and verify() catches any drift. Only present when both
  // drivers implement transaction().
  // -------------------------------------------------------------------------
  let transactionFn: StorageDriver['transaction'];
  if (primary.transaction && shadow.transaction) {
    const primaryTransaction = primary.transaction.bind(primary);
    const shadowTransaction = shadow.transaction.bind(shadow);
    transactionFn = <T,>(
      tables: string[],
      mode: 'rw',
      fn: (tx: StorageTransactionScope) => Promise<T>,
    ): Promise<T> =>
      dualWrite(
        () => primaryTransaction(tables, mode, fn),
        () => shadowTransaction(tables, mode, fn),
      );
  }

  const wrapper: DualWriteDriver = {
    name: primary.name,
    isDualWrite: true,
    primary,
    shadow,
    get shadowHealthy() {
      return shadowHealthy;
    },
    get shadowErrorCount() {
      return shadowErrorCount;
    },
    verify(): Promise<VerificationReport> {
      return verifyMigration(primary, shadow);
    },

    async ready(): Promise<boolean> {
      try {
        return await primary.ready();
      } catch {
        return false;
      }
    },

    settings,
    chunks,
    reviewItems,
    questionResults,
    masterySnapshots,
    // crossDomainBridge is a READ projection used by the host→LSAT sync hook.
    // Surface it during the soak so sync keeps working: prefer the primary's
    // bridge, falling back to the shadow's (the SurrealDB primary doesn't
    // implement the bridge today, so this routes through the in-sync Dexie
    // shadow — which mirrors every soak-window write).
    crossDomainBridge: primary.crossDomainBridge ?? shadow.crossDomainBridge,
    table: tableFn,
    transaction: transactionFn,
  };

  return wrapper;
}
