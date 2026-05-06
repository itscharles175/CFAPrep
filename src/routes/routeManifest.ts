export type RouteBoundary = 'page' | 'domain';
export type RouteDomain = 'home' | 'cfa' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'tool';
export type RouteAccentRole = 'study' | 'exam' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'danger';
export type PreferredLayout = 'dashboard' | 'learning' | 'assessment' | 'tool' | 'ops';

export type AppRouteId =
  | 'dashboard'
  | 'cfa-dashboard'
  | 'cfa-module'
  | 'cfa-quiz'
  | 'cfa-vignette'
  | 'cfa-constructed-response'
  | 'quant-dashboard'
  | 'quant-module'
  | 'excel-dashboard'
  | 'excel-module'
  | 'calculators'
  | 'formulas'
  | 'review'
  | 'vault'
  | 'flashcards'
  | 'mock'
  | 'level-mock'
  | 'analytics'
  | 'content-ops'
  | 'system';

export interface AppRoute {
  id: AppRouteId;
  path: string;
  expectedText: string;
  boundary?: RouteBoundary;
  boundaryName?: string;
  domain: RouteDomain;
  navGroup: string;
  iconKey: string;
  accentRole: RouteAccentRole;
  preferredLayout: PreferredLayout;
  navOrder: number;
  navLabel: string;
  searchGroup: string;
  offlineCritical: boolean;
  keyboardScopes: string[];
  smokeRoute?: string;
  screenshotRoute?: string;
}

export interface SearchRoute {
  id: string;
  title: string;
  subtitle: string;
  type: string;
  path: string;
  keywords: string[];
  disabled?: boolean;
}

export interface CommandRoute {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  keywords: string[];
  action?: 'backup' | 'repair' | 'theme';
}

const baseAppRoutes: Array<Omit<AppRoute, 'navOrder' | 'navLabel' | 'searchGroup' | 'offlineCritical' | 'keyboardScopes'>> = [
  { id: 'dashboard', path: '/', expectedText: 'QuantVault', domain: 'home', navGroup: 'home', iconKey: 'home', accentRole: 'study', preferredLayout: 'dashboard', smokeRoute: '/', screenshotRoute: '/' },
  { id: 'cfa-dashboard', path: '/cfa', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa', domain: 'cfa', navGroup: 'domains', iconKey: 'graduation-cap', accentRole: 'exam', preferredLayout: 'dashboard', smokeRoute: '/cfa', screenshotRoute: '/cfa' },
  { id: 'cfa-module', path: '/cfa/:level/:topic', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-module', domain: 'cfa', navGroup: 'domains', iconKey: 'book-open', accentRole: 'exam', preferredLayout: 'learning', smokeRoute: '/cfa/level1/fixed-income', screenshotRoute: '/cfa/level1/fixed-income' },
  { id: 'cfa-quiz', path: '/cfa/:level/:topic/quiz', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-quiz', domain: 'cfa', navGroup: 'practice', iconKey: 'target', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/level1/fixed-income/quiz', screenshotRoute: '/cfa/level1/fixed-income/quiz' },
  { id: 'cfa-vignette', path: '/cfa/:level/:topic/vignette', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-vignette', domain: 'cfa', navGroup: 'practice', iconKey: 'layers', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/level1/fixed-income/vignette', screenshotRoute: '/cfa/level2/equity/vignette' },
  { id: 'cfa-constructed-response', path: '/cfa/:level/:topic/constructed-response', expectedText: 'LEVEL III RESPONSE', boundary: 'domain', boundaryName: 'cfa-cr', domain: 'cfa', navGroup: 'practice', iconKey: 'pen-line', accentRole: 'exam', preferredLayout: 'assessment', screenshotRoute: '/cfa/level3/performance/constructed-response' },
  { id: 'quant-dashboard', path: '/quant', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant', domain: 'quant', navGroup: 'domains', iconKey: 'brain-circuit', accentRole: 'quant', preferredLayout: 'dashboard', smokeRoute: '/quant', screenshotRoute: '/quant' },
  { id: 'quant-module', path: '/quant/:module', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant-module', domain: 'quant', navGroup: 'domains', iconKey: 'cpu', accentRole: 'quant', preferredLayout: 'tool', smokeRoute: '/quant/risk-management' },
  { id: 'excel-dashboard', path: '/excel', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel', domain: 'excel', navGroup: 'domains', iconKey: 'table-2', accentRole: 'excel', preferredLayout: 'dashboard', smokeRoute: '/excel', screenshotRoute: '/excel' },
  { id: 'excel-module', path: '/excel/:module', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel-module', domain: 'excel', navGroup: 'domains', iconKey: 'file-spreadsheet', accentRole: 'excel', preferredLayout: 'tool', smokeRoute: '/excel/fundamentals' },
  { id: 'calculators', path: '/calculators', expectedText: 'Calculators', domain: 'tool', navGroup: 'tools', iconKey: 'calculator', accentRole: 'study', preferredLayout: 'tool', smokeRoute: '/calculators' },
  { id: 'formulas', path: '/formulas', expectedText: 'Formula', domain: 'tool', navGroup: 'tools', iconKey: 'library', accentRole: 'study', preferredLayout: 'tool' },
  { id: 'review', path: '/review', expectedText: 'Review', domain: 'vault', navGroup: 'tools', iconKey: 'inbox', accentRole: 'vault', preferredLayout: 'dashboard', smokeRoute: '/review', screenshotRoute: '/review' },
  { id: 'vault', path: '/vault', expectedText: 'Vault', domain: 'vault', navGroup: 'tools', iconKey: 'notebook-tabs', accentRole: 'vault', preferredLayout: 'tool', smokeRoute: '/vault', screenshotRoute: '/vault' },
  { id: 'flashcards', path: '/flashcards', expectedText: 'Flashcards', domain: 'tool', navGroup: 'practice', iconKey: 'badge-check', accentRole: 'study', preferredLayout: 'assessment', smokeRoute: '/flashcards', screenshotRoute: '/flashcards' },
  { id: 'mock', path: '/cfa/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/mock' },
  { id: 'level-mock', path: '/cfa/:level/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', screenshotRoute: '/cfa/level3/mock' },
  { id: 'analytics', path: '/analytics', expectedText: 'Analytics', domain: 'analytics', navGroup: 'tools', iconKey: 'bar-chart-3', accentRole: 'analytics', preferredLayout: 'dashboard', smokeRoute: '/analytics', screenshotRoute: '/analytics' },
  { id: 'content-ops', path: '/content-ops', expectedText: 'Content Operations', domain: 'ops', navGroup: 'ops', iconKey: 'file-search', accentRole: 'ops', preferredLayout: 'ops', smokeRoute: '/content-ops', screenshotRoute: '/content-ops' },
  { id: 'system', path: '/system', expectedText: 'System', domain: 'ops', navGroup: 'ops', iconKey: 'hard-drive', accentRole: 'ops', preferredLayout: 'ops', smokeRoute: '/system', screenshotRoute: '/system' },
];

const routeLabels: Partial<Record<AppRouteId, string>> = {
  dashboard: 'Dashboard',
  'cfa-dashboard': 'CFA Program',
  'cfa-module': 'CFA Module',
  'cfa-quiz': 'CFA Quiz',
  'cfa-vignette': 'CFA Vignette',
  'cfa-constructed-response': 'Constructed Response',
  'quant-dashboard': 'Quant Finance',
  'quant-module': 'Quant Module',
  'excel-dashboard': 'Excel Training',
  'excel-module': 'Excel Module',
  calculators: 'Calculators',
  formulas: 'Formula Library',
  review: 'Review Inbox',
  vault: 'Notes & Bookmarks',
  flashcards: 'Flashcards',
  mock: 'Mock Exam',
  'level-mock': 'Level Mock',
  analytics: 'Analytics',
  'content-ops': 'Content QA',
  system: 'System Health',
};

const offlineCriticalRouteIds = new Set<AppRouteId>([
  'dashboard',
  'cfa-dashboard',
  'cfa-module',
  'cfa-quiz',
  'cfa-vignette',
  'cfa-constructed-response',
  'mock',
  'level-mock',
  'review',
  'vault',
  'flashcards',
  'system',
]);

const keyboardScopesByRoute: Partial<Record<AppRouteId, string[]>> = {
  dashboard: ['command-palette', 'sidebar'],
  'cfa-quiz': ['quiz-options', 'confidence', 'error-tags'],
  'cfa-vignette': ['case-items', 'vignette-submit'],
  'cfa-constructed-response': ['response-editor', 'rubric-scorer'],
  mock: ['mock-navigation', 'flagging', 'pause-resume'],
  'level-mock': ['mock-navigation', 'flagging', 'pause-resume'],
  flashcards: ['card-reveal', 'card-rating'],
  review: ['segmented-filter', 'task-actions'],
  vault: ['dialogs', 'import-export'],
  'content-ops': ['tables', 'evidence-links'],
  system: ['backup-actions', 'release-matrix'],
};

export const appRoutes: AppRoute[] = baseAppRoutes.map((route, index) => ({
  ...route,
  navOrder: index + 1,
  navLabel: routeLabels[route.id] || route.expectedText,
  searchGroup: route.navGroup,
  offlineCritical: offlineCriticalRouteIds.has(route.id),
  keyboardScopes: keyboardScopesByRoute[route.id] || ['route'],
}));

export const searchToolRoutes: SearchRoute[] = [
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

export const commandRoutes: CommandRoute[] = [
  { id: 'command:review', title: 'Open Review Inbox', subtitle: 'Due work, weak objectives, and flags', path: '/review', keywords: ['review inbox due weak stale flags'] },
  { id: 'command:mock-level1', title: 'Start Level I Mock', subtitle: 'Timed standalone and vignette section', path: '/cfa/level1/mock', keywords: ['start level i mock exam timed'] },
  { id: 'command:mock-level2', title: 'Start Level II Mock', subtitle: 'Timed item-set section', path: '/cfa/level2/mock', keywords: ['start level ii mock item set vignette'] },
  { id: 'command:mock-level3', title: 'Start Level III Mock', subtitle: 'Constructed response and item-set section', path: '/cfa/level3/mock', keywords: ['start level iii mock constructed response essay'] },
  { id: 'command:system', title: 'Open System Health', subtitle: 'Offline cache, storage, and backup status', path: '/system', keywords: ['system health pwa offline storage backup'] },
  { id: 'action:backup', title: 'Export Vault Backup', subtitle: 'Download all local data as JSON', path: '/vault', keywords: ['export backup vault json local data'], action: 'backup' },
  { id: 'action:repair', title: 'Repair Local Vault', subtitle: 'Rebuild indexes and clean corrupted rows', path: '/review', keywords: ['repair vault rebuild indexes corrupted rows'], action: 'repair' },
  { id: 'action:theme', title: 'Toggle Theme', subtitle: 'Switch light or dark mode', path: '/', keywords: ['toggle theme light dark'], action: 'theme' },
];

export const smokeRoutes: Array<[string, string]> = [
  ...appRoutes
    .filter((route) => route.smokeRoute)
    .map((route) => [route.smokeRoute as string, route.expectedText] as [string, string]),
];

export const screenshotRoutes = appRoutes
  .filter((route) => route.screenshotRoute)
  .map((route) => ({
    id: route.id,
    path: route.screenshotRoute as string,
    expectedText: route.expectedText,
    domain: route.domain,
    accentRole: route.accentRole,
    preferredLayout: route.preferredLayout,
    viewports: ['desktop', 'mobile'] as const,
  }));
