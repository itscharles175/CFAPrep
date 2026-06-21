/**
 * TEST-3 (Wave 2 measurement substrate) — fast-check PROPERTY suite for the host
 * import / merge path (`importVaultData` in `./progressStore.ts`).
 *
 * Two laws, grounded in the real public export/import API and the documented
 * merge semantics:
 *
 *   1. IDEMPOTENCE into an empty vault — merging an export of N keyed `notes`
 *      into a freshly-reset vault reproduces exactly those rows (by id), and
 *      merging the SAME export a second time does not change the logical state
 *      (keyed `bulkPut` on the same primary keys is idempotent).
 *
 *   2. NEVER LOSE A STRICTLY-NEWER RECORD — when an imported row collides with an
 *      existing row on the primary key, `conflictPolicy: 'prefer-import'` keeps the
 *      imported (strictly-newer) version. Merge never silently drops it.
 *
 * Why `notes` and not `reviewItems`: `importVaultData` finishes by calling
 * `rebuildLearningIndexes`, which CLEARS + rebuilds the derived stores
 * (reviewItems / masterySnapshots / reviewEvents / confidenceCalibration) from
 * the canonical `questionResults`. So those stores can't carry an injected row
 * through an import. `notes` is a user-keyed, non-derived store (primary key =
 * `id`) that survives the rebuild verbatim — the right surface to assert these
 * keyed-merge laws against.
 *
 * Runs are SMALL + SEEDED and the suite uses the same `fake-indexeddb/auto`
 * harness the rest of progressStore.test.ts relies on (wired globally via
 * src/setupTests.js) — no live sidecar/LLM, fully deterministic. We never edit
 * the module under test; we drive it only through its public API.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  exportVaultData,
  importVaultData,
  resetVaultData,
  type VaultExport,
} from './progressStore';
import type { VaultNote } from './learningTypes';

// Each run drives a full importVaultData (Dexie reset + rebuildLearningIndexes),
// so keep numRuns modest; under v8 coverage instrumentation this heavy path needs
// a generous per-test timeout (set as the 3rd arg to each it() below).
const FC = { numRuns: 12, seed: 0x3eed } as const;
const HEAVY_TIMEOUT_MS = 30_000;

/** A keyed VaultNote (primary key = `id`) — the store we exercise the merge over. */
function noteArb(): fc.Arbitrary<VaultNote> {
  return fc
    .record({
      n: fc.integer({ min: 0, max: 9 }),
      body: fc.string({ maxLength: 24 }),
      updatedDay: fc.integer({ min: 1, max: 300 }),
    })
    .map(
      (p): VaultNote => ({
        // Constrain the id space so collisions actually happen across two sets.
        id: `general:cfa:note-${p.n}`,
        type: 'general',
        domain: 'cfa',
        title: `Note ${p.n}`,
        body: p.body,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: new Date(Date.UTC(2026, 0, p.updatedDay)).toISOString(),
      }),
    );
}

/** De-dupe by id (last write wins) so an "export" carries a set, not a multiset. */
function dedupeById(notes: VaultNote[]): VaultNote[] {
  const byId = new Map<string, VaultNote>();
  for (const note of notes) byId.set(note.id, note);
  return [...byId.values()];
}

/** Build a VALID VaultExport from the current (reset) vault, swapping in notes. */
async function exportWithNotes(notes: VaultNote[]): Promise<VaultExport> {
  const base = (await exportVaultData()) as VaultExport;
  base.stores.notes = notes;
  // We mutated a store, so the embedded checksum no longer matches. Dropping it
  // makes validateVaultData treat checksum as not-present (checksumValid is only
  // enforced when a checksum is supplied) — the same trick the example tests use.
  delete (base as Partial<VaultExport>).checksum;
  return base;
}

async function currentNotesById(): Promise<Map<string, VaultNote>> {
  const out = (await exportVaultData()) as VaultExport;
  return new Map(out.stores.notes.map((note) => [note.id, note]));
}

describe('importVaultData merge invariants', () => {
  beforeEach(async () => {
    await resetVaultData('full');
  });

  it('merging into an empty vault reproduces the imported keyed rows exactly', () => {
    return fc.assert(
      fc.asyncProperty(fc.array(noteArb(), { maxLength: 8 }), async (rawNotes) => {
        const notes = dedupeById(rawNotes);
        await resetVaultData('full');

        await importVaultData(await exportWithNotes(notes), {
          mode: 'merge',
          conflictPolicy: 'prefer-import',
        });

        const after = await currentNotesById();
        expect(after.size).toBe(notes.length);
        for (const note of notes) {
          expect(after.get(note.id)?.body).toBe(note.body);
          expect(after.get(note.id)?.updatedAt).toBe(note.updatedAt);
        }
      }),
      FC,
    );
  }, HEAVY_TIMEOUT_MS);

  it('is idempotent — merging the same export twice yields the same logical state', () => {
    return fc.assert(
      fc.asyncProperty(fc.array(noteArb(), { maxLength: 8 }), async (rawNotes) => {
        const notes = dedupeById(rawNotes);
        await resetVaultData('full');
        const exportPayload = await exportWithNotes(notes);

        await importVaultData(exportPayload, { mode: 'merge', conflictPolicy: 'prefer-import' });
        const once = await currentNotesById();
        await importVaultData(exportPayload, { mode: 'merge', conflictPolicy: 'prefer-import' });
        const twice = await currentNotesById();

        expect(twice.size).toBe(once.size);
        for (const [id, note] of once) {
          expect(twice.get(id)?.body).toBe(note.body);
          expect(twice.get(id)?.updatedAt).toBe(note.updatedAt);
        }
      }),
      FC,
    );
  }, HEAVY_TIMEOUT_MS);

  it('prefer-import never loses a strictly-newer record on a primary-key collision', () => {
    return fc.assert(
      fc.asyncProperty(fc.array(noteArb(), { minLength: 1, maxLength: 6 }), async (rawNotes) => {
        const existing = dedupeById(rawNotes);
        await resetVaultData('full');

        // Seed the vault with the "existing" (older) rows.
        await importVaultData(await exportWithNotes(existing), { mode: 'replace' });

        // Build a STRICTLY-NEWER import: same ids, a later updatedAt + distinct body
        // so we can prove which version won the merge.
        const incoming = existing.map((note, i) => ({
          ...note,
          body: `${note.body}#updated-${i}`,
          updatedAt: '2099-01-01T00:00:00.000Z',
        }));

        await importVaultData(await exportWithNotes(incoming), {
          mode: 'merge',
          conflictPolicy: 'prefer-import',
        });

        const after = await currentNotesById();
        // No row-count change (collisions, not inserts) and every row carries the
        // newer body/timestamp — the newer record survived the merge.
        expect(after.size).toBe(existing.length);
        for (const note of incoming) {
          expect(after.get(note.id)?.body).toBe(note.body);
          expect(after.get(note.id)?.updatedAt).toBe('2099-01-01T00:00:00.000Z');
        }
      }),
      FC,
    );
  }, HEAVY_TIMEOUT_MS);
});
