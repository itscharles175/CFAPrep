/**
 * Shared route metadata for the app shell, command palette, and smoke tests.
 * Keep component wiring in App.jsx; this file stays framework-light so Node
 * release scripts can import it directly.
 *
 * @typedef {'page' | 'domain'} RouteBoundary
 * @typedef {{ id: string, path: string, expectedText: string, boundary?: RouteBoundary, boundaryName?: string }} AppRoute
 * @typedef {{ id: string, title: string, subtitle: string, type: string, path: string, keywords: string[], disabled?: boolean }} SearchRoute
 * @typedef {{ id: string, title: string, subtitle: string, path: string, keywords: string[], action?: 'backup' | 'repair' | 'theme' }} CommandRoute
 */

/** @type {AppRoute[]} */
export const appRoutes = [
  { id: 'dashboard', path: '/', expectedText: 'QuantVault' },
  { id: 'cfa-dashboard', path: '/cfa', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa' },
  { id: 'cfa-module', path: '/cfa/:level/:topic', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-module' },
  { id: 'cfa-quiz', path: '/cfa/:level/:topic/quiz', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-quiz' },
  { id: 'cfa-vignette', path: '/cfa/:level/:topic/vignette', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-vignette' },
  { id: 'cfa-constructed-response', path: '/cfa/:level/:topic/constructed-response', expectedText: 'Constructed', boundary: 'domain', boundaryName: 'cfa-cr' },
  { id: 'quant-dashboard', path: '/quant', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant' },
  { id: 'quant-module', path: '/quant/:module', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant-module' },
  { id: 'excel-dashboard', path: '/excel', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel' },
  { id: 'excel-module', path: '/excel/:module', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel-module' },
  { id: 'calculators', path: '/calculators', expectedText: 'Calculators' },
  { id: 'formulas', path: '/formulas', expectedText: 'Formula' },
  { id: 'review', path: '/review', expectedText: 'Review' },
  { id: 'vault', path: '/vault', expectedText: 'Vault' },
  { id: 'flashcards', path: '/flashcards', expectedText: 'Flashcards' },
  { id: 'mock', path: '/cfa/mock', expectedText: 'Mock' },
  { id: 'level-mock', path: '/cfa/:level/mock', expectedText: 'Mock' },
  { id: 'analytics', path: '/analytics', expectedText: 'Analytics' },
  { id: 'content-ops', path: '/content-ops', expectedText: 'Content Operations' },
  { id: 'system', path: '/system', expectedText: 'System' },
];

/** @type {SearchRoute[]} */
export const searchToolRoutes = [
  {
    id: 'tool:review',
    title: 'Review Inbox',
    subtitle: 'Due reviews, weak objectives, missed questions, and unfinished lessons',
    type: 'Tool',
    path: '/review',
    keywords: ['review inbox due weak objectives missed questions bookmarks stale unfinished lessons'],
  },
  {
    id: 'tool:flashcards',
    title: 'Flashcards',
    subtitle: 'Formula, objective, and bookmark drills',
    type: 'Tool',
    path: '/flashcards',
    keywords: ['flashcards formulas definitions objectives bookmarks drill'],
  },
  {
    id: 'tool:vault',
    title: 'Notes & Bookmarks',
    subtitle: 'Local notes and saved items',
    type: 'Tool',
    path: '/vault',
    keywords: ['notes bookmarks local vault saved'],
  },
  {
    id: 'tool:mock',
    title: 'CFA Level I Mock Exam',
    subtitle: 'Timed mixed-topic Level I section',
    type: 'Tool',
    path: '/cfa/mock',
    keywords: ['mock exam section cfa timed mixed practice'],
  },
  {
    id: 'tool:mock-level2',
    title: 'CFA Level II Mock Exam',
    subtitle: 'Timed item-set mixed section',
    type: 'Tool',
    path: '/cfa/level2/mock',
    keywords: ['level ii level 2 mock exam vignette item set timed cfa'],
  },
  {
    id: 'tool:mock-level3',
    title: 'CFA Level III Mock Exam',
    subtitle: 'Timed constructed-response and item-set section',
    type: 'Tool',
    path: '/cfa/level3/mock',
    keywords: ['level iii level 3 mock exam constructed response essay item set cfa'],
  },
  {
    id: 'tool:vignette',
    title: 'Start CFA Vignette',
    subtitle: 'Open a Level II equity item set',
    type: 'Command',
    path: '/cfa/level2/equity/vignette',
    keywords: ['start vignette item set case level 2 equity'],
  },
  {
    id: 'tool:constructed-response',
    title: 'Start Constructed Response',
    subtitle: 'Open a Level III portfolio response drill',
    type: 'Command',
    path: '/cfa/level3/portfolio-construction/constructed-response',
    keywords: ['constructed response essay level 3 command word rubric'],
  },
  {
    id: 'tool:formula-drill',
    title: 'Start Formula Drill',
    subtitle: 'Open local flashcards generated from all CFA levels',
    type: 'Command',
    path: '/flashcards',
    keywords: ['formula drill flashcard start formulas objectives'],
  },
  {
    id: 'tool:analytics',
    title: 'Learning Analytics',
    subtitle: 'Accuracy, confidence, error type, and trend signals',
    type: 'Tool',
    path: '/analytics',
    keywords: ['analytics readiness accuracy confidence calibration errors trend topic difficulty'],
  },
  {
    id: 'tool:content-ops',
    title: 'Content QA',
    subtitle: 'Catalog coverage and validation',
    type: 'Tool',
    path: '/content-ops',
    keywords: ['content qa validation coverage duplicate answer key formula'],
  },
  {
    id: 'tool:system',
    title: 'System Health',
    subtitle: 'Offline cache, storage quota, and backup status',
    type: 'Tool',
    path: '/system',
    keywords: ['system health pwa offline cache storage quota backup service worker'],
  },
];

/** @type {CommandRoute[]} */
export const commandRoutes = [
  { id: 'command:review', title: 'Open Review Inbox', subtitle: 'Due work, weak objectives, and flags', path: '/review', keywords: ['review inbox due weak stale flags'] },
  { id: 'command:mock-level1', title: 'Start Level I Mock', subtitle: 'Timed standalone and vignette section', path: '/cfa/level1/mock', keywords: ['start level i mock exam timed'] },
  { id: 'command:mock-level2', title: 'Start Level II Mock', subtitle: 'Timed item-set section', path: '/cfa/level2/mock', keywords: ['start level ii mock item set vignette'] },
  { id: 'command:mock-level3', title: 'Start Level III Mock', subtitle: 'Constructed response and item-set section', path: '/cfa/level3/mock', keywords: ['start level iii mock constructed response essay'] },
  { id: 'command:system', title: 'Open System Health', subtitle: 'Offline cache, storage, and backup status', path: '/system', keywords: ['system health pwa offline storage backup'] },
  { id: 'action:backup', title: 'Export Vault Backup', subtitle: 'Download all local data as JSON', path: '/vault', keywords: ['export backup vault json local data'], action: 'backup' },
  { id: 'action:repair', title: 'Repair Local Vault', subtitle: 'Rebuild indexes and clean corrupted rows', path: '/review', keywords: ['repair vault rebuild indexes corrupted rows'], action: 'repair' },
  { id: 'action:theme', title: 'Toggle Theme', subtitle: 'Switch light or dark mode', path: '/', keywords: ['toggle theme light dark'], action: 'theme' },
];

/** @type {Array<[string, string]>} */
export const smokeRoutes = [
  ['/', 'QuantVault'],
  ['/cfa', 'CFA'],
  ['/cfa/level1/fixed-income', 'Fixed Income'],
  ['/cfa/level1/fixed-income/quiz', 'Fixed Income'],
  ['/cfa/level1/fixed-income/vignette', 'Fixed Income'],
  ['/cfa/mock', 'Mock'],
  ['/flashcards', 'Flashcards'],
  ['/review', 'Review'],
  ['/vault', 'Vault'],
  ['/analytics', 'Analytics'],
  ['/content-ops', 'Content Operations'],
  ['/calculators', 'Calculators'],
  ['/quant', 'Quant'],
  ['/quant/risk-management', 'Risk'],
  ['/excel', 'Excel'],
  ['/excel/fundamentals', 'Excel'],
  ['/system', 'System'],
];
