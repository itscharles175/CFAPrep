await import('fake-indexeddb/auto');

const {
  exportVaultData,
  getReviewInbox,
  importVaultData,
  recordQuizAttempt,
  resetVaultData,
  saveNote,
  saveResultArtifact,
  saveStudyPlanSettings,
  toggleBookmark,
  validateVaultData,
} = await import('../src/lib/learning/index.ts');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function storeCount(exported, store) {
  return exported.stores[store]?.length || 0;
}

await resetVaultData('full');

await recordQuizAttempt({
  domain: 'cfa',
  topic: 'fixed-income',
  title: 'Fixed Income Fresh Import Check',
  mode: 'topic-drill',
  score: 0,
  total: 1,
  elapsedSeconds: 45,
  answers: [
    {
      level: 'level1',
      questionId: 'fresh-import-fi-1',
      learningObjective: 'fresh-import-fi-lo',
      objectiveTitle: 'Fresh import objective',
      correct: false,
      confidence: 'low',
      errorCategory: 'concept',
      difficulty: 'foundation',
      selected: 0,
      correctIndex: 1,
      itemType: 'single',
      path: '/cfa/level1/fixed-income/quiz',
    },
  ],
});

await saveStudyPlanSettings({
  targetLevel: 'level1',
  dailyTargetMinutes: 75,
  examDate: '2026-12-31',
  restDays: [0],
  mockCadenceDays: 21,
});

await saveNote({
  type: 'lesson',
  domain: 'cfa',
  moduleId: 'level1/fixed-income',
  title: 'Fresh import note',
  body: 'Local backup should restore this note.',
  path: '/cfa/level1/fixed-income',
});

await toggleBookmark({
  type: 'question',
  domain: 'cfa',
  questionId: 'fresh-import-fi-1',
  title: 'Fresh import question bookmark',
  path: '/cfa/level1/fixed-income/quiz',
});

await saveResultArtifact({
  type: 'calculator',
  domain: 'cfa',
  level: 'level1',
  topic: 'fixed-income',
  title: 'Fresh Import Bond Artifact',
  summary: 'Synthetic artifact used to verify clean-profile restore.',
  assumptions: { faceValue: 1000, couponRate: 0.05 },
  metrics: { price: 982.5 },
  path: '/calculators',
  objectiveIds: ['fresh-import-fi-lo'],
});

const exported = await exportVaultData();
const validation = validateVaultData(exported);
assert(validation.valid, `Export validation failed: ${validation.errors.join('; ')}`);
assert(storeCount(exported, 'questionResults') === 1, 'Expected one question result before reset.');
assert(storeCount(exported, 'notes') === 1, 'Expected one note before reset.');
assert(storeCount(exported, 'bookmarks') === 1, 'Expected one bookmark before reset.');
assert(storeCount(exported, 'resultArtifacts') === 1, 'Expected one artifact before reset.');

await resetVaultData('full');
const empty = await exportVaultData();
assert(storeCount(empty, 'questionResults') === 0, 'Fresh profile reset did not clear question results.');

await importVaultData(exported, 'replace');
const restored = await exportVaultData();
const inbox = await getReviewInbox();

assert(storeCount(restored, 'questionResults') === 1, 'Question result did not restore into fresh profile.');
assert(storeCount(restored, 'reviewItems') >= 1, 'Derived review item was not rebuilt after import.');
assert(storeCount(restored, 'masterySnapshots') >= 1, 'Derived mastery snapshot was not rebuilt after import.');
assert(storeCount(restored, 'notes') === 1, 'Note did not restore into fresh profile.');
assert(storeCount(restored, 'bookmarks') === 1, 'Bookmark did not restore into fresh profile.');
assert(storeCount(restored, 'resultArtifacts') === 1, 'Artifact did not restore into fresh profile.');
assert(storeCount(restored, 'studyPlanSettings') === 1, 'Study planner settings did not restore into fresh profile.');
assert(inbox.some((item) => item.type === 'weak-objective'), 'Review inbox did not rebuild weak-objective work.');

console.log('Fresh-profile export/import check passed.');
console.log(
  JSON.stringify(
    {
      questionResults: storeCount(restored, 'questionResults'),
      reviewItems: storeCount(restored, 'reviewItems'),
      masterySnapshots: storeCount(restored, 'masterySnapshots'),
      notes: storeCount(restored, 'notes'),
      bookmarks: storeCount(restored, 'bookmarks'),
      resultArtifacts: storeCount(restored, 'resultArtifacts'),
      studyPlanSettings: storeCount(restored, 'studyPlanSettings'),
      reviewInboxItems: inbox.length,
    },
    null,
    2,
  ),
);

await resetVaultData('full');

