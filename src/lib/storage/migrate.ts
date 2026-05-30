import type { StorageDriver } from './types';

/**
 * Result of copying data between two storage drivers.
 *
 * Counts are per-namespace rows successfully written to the target.
 * `skipped` names namespaces that could not be migrated generically through
 * the driver interface (today: `chunks`, which exposes search/upsert but no
 * "read all" — those are re-derived from `sourceDocuments` on re-ingestion).
 */
export interface MigrationReport {
  settings: number;
  reviewItems: number;
  questionResults: number;
  masterySnapshots: number;
  skipped: string[];
}

/**
 * Copy every readable namespace from `from` into `to`.
 *
 * Idempotent for keyed namespaces (settings/reviewItems/masterySnapshots use
 * upsert semantics). `questionResults` is an append-only log, so a re-run
 * would duplicate rows — callers should migrate into a fresh target or guard
 * against double-runs (the cutover orchestration does this by only migrating
 * on the first switch).
 *
 * Throws if a namespace the target claims to support fails mid-write — the
 * caller is expected to roll the active driver back.
 */
export async function migrateData(from: StorageDriver, to: StorageDriver): Promise<MigrationReport> {
  const report: MigrationReport = {
    settings: 0,
    reviewItems: 0,
    questionResults: 0,
    masterySnapshots: 0,
    skipped: [],
  };

  // settings — always present on both drivers.
  const settingsRows = await from.settings.toArray();
  for (const row of settingsRows) {
    await to.settings.put(row);
  }
  report.settings = settingsRows.length;

  // reviewItems
  if (from.reviewItems && to.reviewItems) {
    const items = await from.reviewItems.toArray();
    if (items.length) await to.reviewItems.bulkPut(items);
    report.reviewItems = items.length;
  } else {
    report.skipped.push('reviewItems');
  }

  // questionResults (append-only)
  if (from.questionResults && to.questionResults) {
    const results = await from.questionResults.toArray();
    if (results.length) await to.questionResults.bulkAdd(results);
    report.questionResults = results.length;
  } else {
    report.skipped.push('questionResults');
  }

  // masterySnapshots
  if (from.masterySnapshots && to.masterySnapshots) {
    const snaps = await from.masterySnapshots.toArray();
    for (const snap of snaps) {
      await to.masterySnapshots.put(snap);
    }
    report.masterySnapshots = snaps.length;
  } else {
    report.skipped.push('masterySnapshots');
  }

  // chunks have no generic "read all" on the interface — they're re-derived
  // from sourceDocuments on re-ingestion, so they're intentionally skipped.
  report.skipped.push('chunks (re-ingest to rebuild the vector index)');

  return report;
}
