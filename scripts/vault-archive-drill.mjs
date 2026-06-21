// GAP-PORT-1 — OFFLINE restore-onto-clean drill (Wave 3a, data-safety).
//
// A backup is only trustworthy if a restore is PROVEN to reproduce it. This drill
// runs the full safety contract headlessly against a fake-indexeddb vault:
//
//   1. SEED   — write representative rows into a clean host vault (attempt log,
//               planner settings, a note, a bookmark, a result artifact).
//   2. BUILD  — export the vault and wrap it in a self-describing, per-store-
//               checksummed VaultArchive (src/lib/storage/vaultArchive.ts).
//   3. WIPE   — resetVaultData('full') — simulate restoring onto a fresh machine.
//   4. IMPORT — importVaultData(export, 'replace') back into the empty vault.
//   5. ASSERT — re-export, rebuild the archive, and require the restored vault's
//               per-store digests to MATCH the original byte-for-byte, AND
//               verifyVaultArchive() to pass on both. Any drift -> non-zero exit.
//
// Mirrors scripts/fresh-import-check.mjs: fake-indexeddb is installed first, then
// the TS modules are dynamically imported (the ts-loader is registered by
// `node --import ./scripts/register-ts-loader.mjs`). Fully offline: no sidecar,
// no LLM, no network. Run via `npm run vault-archive:drill` (or directly:
// `node --import ./scripts/register-ts-loader.mjs scripts/vault-archive-drill.mjs`).

await import('fake-indexeddb/auto');

const {
  exportVaultData,
  importVaultData,
  resetVaultData,
  validateVaultData,
} = await import('../src/lib/progressStore.ts');
const { recordQuizAttempt, saveNote, saveStudyPlanSettings, saveResultArtifact, toggleBookmark } =
  await import('../src/lib/learning/index.ts');
const { buildVaultArchive, verifyVaultArchive } = await import('../src/lib/storage/vaultArchive.ts');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function digestMap(archive) {
  const map = new Map();
  for (const entry of archive.manifest.stores) {
    map.set(entry.name, { count: entry.count, sha256: entry.sha256 });
  }
  return map;
}

// importVaultData is NOT a pure byte-for-byte round-trip BY DESIGN — and that is
// itself a data-safety feature. On restore the host:
//   - re-derives masterySnapshots / reviewEvents / confidenceCalibration from the
//     (faithfully restored) attempt log via rebuildLearningIndexes(), so a backup
//     can't smuggle a stale/forged derived index over a fresh recomputation;
//   - records a fresh rollbackSnapshot (so the restore is itself undoable);
//   - appends an importJobs audit row + a "last import" settings marker.
// So the trustworthy invariant the drill enforces is: every USER-AUTHORED
// SOURCE-OF-TRUTH store survives EXACTLY (byte-for-byte canonical digest), while
// the host's own derived/operational stores are merely required to still be
// PRESENT and non-empty where they were seeded (they're rebuilt, not preserved).
// This mirrors fresh-import-check.mjs, which asserts `>= 1` for derived stores.
const DERIVED_OR_OPERATIONAL_STORES = new Set([
  'host:masterySnapshots',
  'host:reviewEvents',
  'host:confidenceCalibration',
  'host:rollbackSnapshots',
  'host:importJobs',
  'host:settings',
]);

// 1. SEED — start clean, then write a representative cross-section of stores.
await resetVaultData('full');

await recordQuizAttempt({
  domain: 'cfa',
  topic: 'fixed-income',
  title: 'Vault Archive Drill',
  mode: 'topic-drill',
  score: 1,
  total: 2,
  elapsedSeconds: 60,
  answers: [
    {
      level: 'level1',
      questionId: 'drill-fi-1',
      learningObjective: 'drill-fi-lo',
      objectiveTitle: 'Drill objective',
      correct: true,
      confidence: 'high',
      errorCategory: 'concept',
      difficulty: 'foundation',
      selected: 1,
      correctIndex: 1,
      itemType: 'single',
      path: '/cfa/level1/fixed-income/quiz',
    },
    {
      level: 'level1',
      questionId: 'drill-fi-2',
      learningObjective: 'drill-fi-lo',
      objectiveTitle: 'Drill objective',
      correct: false,
      confidence: 'low',
      errorCategory: 'concept',
      difficulty: 'foundation',
      selected: 0,
      correctIndex: 2,
      itemType: 'single',
      path: '/cfa/level1/fixed-income/quiz',
    },
  ],
});

await saveStudyPlanSettings({
  targetLevel: 'level1',
  dailyTargetMinutes: 90,
  examDate: '2026-12-31',
  restDays: [0],
  mockCadenceDays: 14,
});

await saveNote({
  type: 'lesson',
  domain: 'cfa',
  moduleId: 'level1/fixed-income',
  title: 'Drill note',
  body: 'A restore drill must reproduce this note byte-for-byte.',
  path: '/cfa/level1/fixed-income',
});

await toggleBookmark({
  type: 'question',
  domain: 'cfa',
  questionId: 'drill-fi-1',
  title: 'Drill bookmark',
  path: '/cfa/level1/fixed-income/quiz',
});

await saveResultArtifact({
  type: 'calculator',
  domain: 'cfa',
  level: 'level1',
  topic: 'fixed-income',
  title: 'Drill Bond Artifact',
  summary: 'Synthetic artifact used to verify checksum-equivalence after restore.',
  assumptions: { faceValue: 1000, couponRate: 0.05 },
  metrics: { price: 982.5 },
  path: '/calculators',
  objectiveIds: ['drill-fi-lo'],
});

// 2. BUILD — export + wrap in a checksummed archive; the archive must self-verify.
const original = await exportVaultData();
const originalValidation = validateVaultData(original);
assert(originalValidation.valid, `Original export failed validation: ${originalValidation.errors.join('; ')}`);

const originalArchive = buildVaultArchive(original, { appVersion: 'drill' });
const originalVerify = verifyVaultArchive(originalArchive);
assert(
  originalVerify.ok,
  `Freshly built archive failed self-verification: ${JSON.stringify(originalVerify.mismatches)}`,
);
assert(originalArchive.manifest.stores.length > 0, 'Archive recorded no stores from a seeded vault.');

const seededAttempts = originalArchive.manifest.stores.find((s) => s.name === 'host:questionResults');
assert(seededAttempts && seededAttempts.count === 2, 'Expected two seeded question-result rows in the archive.');

// 3. WIPE — restore-onto-clean: tear the vault down to empty.
await resetVaultData('full');
const empty = await exportVaultData();
const emptyArchive = buildVaultArchive(empty, { appVersion: 'drill' });
const emptyAttempts = emptyArchive.manifest.stores.find((s) => s.name === 'host:questionResults');
assert(!emptyAttempts || emptyAttempts.count === 0, 'Wipe did not clear the question-result store.');

// 4. IMPORT — bring the original export back into the now-empty vault.
await importVaultData(original, 'replace');

// 5. ASSERT — re-export, rebuild, and require byte-for-byte digest equivalence.
const restored = await exportVaultData();
const restoredValidation = validateVaultData(restored);
assert(restoredValidation.valid, `Restored export failed validation: ${restoredValidation.errors.join('; ')}`);

const restoredArchive = buildVaultArchive(restored, { appVersion: 'drill' });
const restoredVerify = verifyVaultArchive(restoredArchive);
assert(
  restoredVerify.ok,
  `Restored archive failed self-verification: ${JSON.stringify(restoredVerify.mismatches)}`,
);

const before = digestMap(originalArchive);
const after = digestMap(restoredArchive);

const mismatches = [];
for (const [name, orig] of before) {
  const back = after.get(name);
  if (!back) {
    mismatches.push(`${name}: store missing after restore`);
    continue;
  }
  if (DERIVED_OR_OPERATIONAL_STORES.has(name)) {
    // Derived/operational store: it must still EXIST, and if the original had
    // rows the restored vault must too (rebuilt from the restored attempt log),
    // but its exact bytes are expected to differ. Do not compare the digest.
    if (orig.count > 0 && back.count === 0) {
      mismatches.push(`${name}: derived store was seeded (${orig.count}) but is empty after restore`);
    }
    continue;
  }
  // Source-of-truth store: must survive EXACTLY.
  if (back.count !== orig.count) {
    mismatches.push(`${name}: count ${orig.count} -> ${back.count}`);
  }
  if (back.sha256 !== orig.sha256) {
    mismatches.push(`${name}: checksum ${orig.sha256.slice(0, 12)}… -> ${back.sha256.slice(0, 12)}…`);
  }
}
for (const name of after.keys()) {
  // A brand-new store after restore is only acceptable when it's a derived/
  // operational one the host populates on import (e.g. host:importJobs/settings
  // in a vault that started with none).
  if (!before.has(name) && !DERIVED_OR_OPERATIONAL_STORES.has(name)) {
    mismatches.push(`${name}: store appeared only after restore`);
  }
}

if (mismatches.length) {
  console.error('Vault archive restore drill FAILED — checksum/equivalence mismatches:');
  for (const m of mismatches) console.error(`  - ${m}`);
  await resetVaultData('full');
  process.exit(1);
}

console.log('Vault archive restore drill passed (export -> wipe -> import == original).');
console.log(
  JSON.stringify(
    {
      stores: originalArchive.manifest.stores.length,
      hostSchemaVersion: originalArchive.manifest.schemaVersions.host,
      questionResults: seededAttempts.count,
      verified: restoredVerify.ok,
    },
    null,
    2,
  ),
);

await resetVaultData('full');
