// QA-1 / K4-0: read the vendored LSAT route manifest so the QA gates (visual,
// a11y, smoke) can crawl the /lsat/* surface, not just host routes. We import the
// SOURCE OF TRUTH for LSAT paths/labels rather than re-listing them, so a path
// rename in the LSAT manifest is caught here at build time. The manifest's own
// imports are inert for the gate (lucide icons + lazy `import()` arrows that are
// never invoked at module-eval time), so importing it from a plain node script
// via the TS loader is safe.
import { routeManifest as lsatRouteManifest } from '../domains/lsat/lib/routeManifest';

export type RouteBoundary = 'page' | 'domain';
export type RouteDomain = 'home' | 'cfa' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'tool';
export type RouteAccentRole = 'study' | 'exam' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'danger';
export type PreferredLayout = 'dashboard' | 'learning' | 'assessment' | 'tool' | 'ops';
export type RouteActionKind = 'navigate' | 'backup' | 'repair' | 'cache' | 'start-assessment' | 'open-drawer' | 'export';
export type PreloadStrategy = 'eager' | 'idle' | 'interaction' | 'manual';
export type QaViewport = 320 | 375 | 414 | 768 | 1024 | 1440;

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
  | 'system'
  | 'today'
  | 'knowledge-graph'
  | 'style';

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
  breadcrumbs: Array<{ label: string; path: string }>;
  routeActions: Array<{ id: string; label: string; kind: RouteActionKind; path?: string; commandId?: string }>;
  keyboardHelp: Array<{ scope: string; keys: string[]; label: string }>;
  offlineWarmup?: { path: string; priority: 'critical' | 'standard' };
  preloadStrategy: PreloadStrategy;
  qaStates: Array<{ id: string; label: string; viewports: QaViewport[] }>;
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

type BaseAppRoute = Omit<
  AppRoute,
  | 'navOrder'
  | 'navLabel'
  | 'searchGroup'
  | 'offlineCritical'
  | 'keyboardScopes'
  | 'breadcrumbs'
  | 'routeActions'
  | 'keyboardHelp'
  | 'offlineWarmup'
  | 'preloadStrategy'
  | 'qaStates'
>;

const baseAppRoutes: BaseAppRoute[] = [
  { id: 'dashboard', path: '/', expectedText: 'QuantVault', domain: 'home', navGroup: 'home', iconKey: 'home', accentRole: 'study', preferredLayout: 'dashboard', smokeRoute: '/', screenshotRoute: '/' },
  { id: 'cfa-dashboard', path: '/cfa', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa', domain: 'cfa', navGroup: 'domains', iconKey: 'graduation-cap', accentRole: 'exam', preferredLayout: 'dashboard', smokeRoute: '/cfa', screenshotRoute: '/cfa' },
  { id: 'cfa-module', path: '/cfa/:level/:topic', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-module', domain: 'cfa', navGroup: 'domains', iconKey: 'book-open', accentRole: 'exam', preferredLayout: 'learning', smokeRoute: '/cfa/level1/fixed-income', screenshotRoute: '/cfa/level1/fixed-income' },
  { id: 'cfa-quiz', path: '/cfa/:level/:topic/quiz', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-quiz', domain: 'cfa', navGroup: 'practice', iconKey: 'target', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/level1/fixed-income/quiz', screenshotRoute: '/cfa/level1/fixed-income/quiz' },
  { id: 'cfa-vignette', path: '/cfa/:level/:topic/vignette', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-vignette', domain: 'cfa', navGroup: 'practice', iconKey: 'layers', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/level1/fixed-income/vignette', screenshotRoute: '/cfa/level2/equity/vignette' },
  { id: 'cfa-constructed-response', path: '/cfa/:level/:topic/constructed-response', expectedText: 'LEVEL III RESPONSE', boundary: 'domain', boundaryName: 'cfa-cr', domain: 'cfa', navGroup: 'practice', iconKey: 'pen-line', accentRole: 'exam', preferredLayout: 'assessment', screenshotRoute: '/cfa/level3/performance/constructed-response' },
  { id: 'quant-dashboard', path: '/quant', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant', domain: 'quant', navGroup: 'domains', iconKey: 'brain-circuit', accentRole: 'quant', preferredLayout: 'dashboard', smokeRoute: '/quant', screenshotRoute: '/quant' },
  { id: 'quant-module', path: '/quant/:module', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant-module', domain: 'quant', navGroup: 'domains', iconKey: 'cpu', accentRole: 'quant', preferredLayout: 'tool', smokeRoute: '/quant/risk-management', screenshotRoute: '/quant/risk-management' },
  { id: 'excel-dashboard', path: '/excel', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel', domain: 'excel', navGroup: 'domains', iconKey: 'table-2', accentRole: 'excel', preferredLayout: 'dashboard', smokeRoute: '/excel', screenshotRoute: '/excel' },
  { id: 'excel-module', path: '/excel/:module', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel-module', domain: 'excel', navGroup: 'domains', iconKey: 'file-spreadsheet', accentRole: 'excel', preferredLayout: 'tool', smokeRoute: '/excel/fundamentals', screenshotRoute: '/excel/dcf-modeling' },
  { id: 'calculators', path: '/calculators', expectedText: 'Calculators', domain: 'tool', navGroup: 'tools', iconKey: 'calculator', accentRole: 'study', preferredLayout: 'tool', smokeRoute: '/calculators', screenshotRoute: '/calculators' },
  { id: 'formulas', path: '/formulas', expectedText: 'Formula', domain: 'tool', navGroup: 'tools', iconKey: 'library', accentRole: 'study', preferredLayout: 'tool', screenshotRoute: '/formulas' },
  { id: 'review', path: '/review', expectedText: 'Review', domain: 'vault', navGroup: 'tools', iconKey: 'inbox', accentRole: 'vault', preferredLayout: 'dashboard', smokeRoute: '/review', screenshotRoute: '/review' },
  { id: 'vault', path: '/vault', expectedText: 'Vault', domain: 'vault', navGroup: 'tools', iconKey: 'notebook-tabs', accentRole: 'vault', preferredLayout: 'tool', smokeRoute: '/vault', screenshotRoute: '/vault' },
  { id: 'flashcards', path: '/flashcards', expectedText: 'Flashcards', domain: 'tool', navGroup: 'practice', iconKey: 'badge-check', accentRole: 'study', preferredLayout: 'assessment', smokeRoute: '/flashcards', screenshotRoute: '/flashcards' },
  { id: 'mock', path: '/cfa/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', smokeRoute: '/cfa/mock' },
  { id: 'level-mock', path: '/cfa/:level/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', screenshotRoute: '/cfa/level3/mock' },
  { id: 'analytics', path: '/analytics', expectedText: 'Analytics', domain: 'analytics', navGroup: 'tools', iconKey: 'bar-chart-3', accentRole: 'analytics', preferredLayout: 'dashboard', smokeRoute: '/analytics', screenshotRoute: '/analytics' },
  { id: 'content-ops', path: '/content-ops', expectedText: 'Content Operations', domain: 'ops', navGroup: 'ops', iconKey: 'file-search', accentRole: 'ops', preferredLayout: 'ops', smokeRoute: '/content-ops', screenshotRoute: '/content-ops' },
  { id: 'system', path: '/system', expectedText: 'System', domain: 'ops', navGroup: 'ops', iconKey: 'hard-drive', accentRole: 'ops', preferredLayout: 'ops', smokeRoute: '/system', screenshotRoute: '/system' },
  { id: 'today', path: '/today', expectedText: 'Today', domain: 'home', navGroup: 'home', iconKey: 'sun', accentRole: 'study', preferredLayout: 'dashboard', smokeRoute: '/today', screenshotRoute: '/today' },
  { id: 'knowledge-graph', path: '/knowledge-graph', expectedText: 'Knowledge Graph', domain: 'analytics', navGroup: 'tools', iconKey: 'network', accentRole: 'analytics', preferredLayout: 'dashboard', smokeRoute: '/knowledge-graph', screenshotRoute: '/knowledge-graph' },
  { id: 'style', path: '/style', expectedText: 'Style', domain: 'tool', navGroup: 'tools', iconKey: 'palette', accentRole: 'study', preferredLayout: 'tool', smokeRoute: '/style', screenshotRoute: '/style' },
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
  today: 'Today',
  'knowledge-graph': 'Knowledge Graph',
  style: 'Style Gallery',
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
  'today',
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

const routeActionsByRoute: Partial<Record<AppRouteId, AppRoute['routeActions']>> = {
  dashboard: [{ id: 'open-review', label: 'Open review', kind: 'navigate', path: '/review', commandId: 'command:review' }],
  'cfa-dashboard': [{ id: 'start-level1-mock', label: 'Start Level I mock', kind: 'start-assessment', path: '/cfa/level1/mock' }],
  'cfa-module': [
    { id: 'start-topic-quiz', label: 'Start quiz', kind: 'start-assessment', path: '/cfa/level1/fixed-income/quiz' },
    { id: 'open-formulas', label: 'Open formulas', kind: 'open-drawer', path: '/formulas' },
  ],
  'cfa-quiz': [{ id: 'flag-question', label: 'Flag question', kind: 'start-assessment' }],
  'cfa-vignette': [{ id: 'review-case', label: 'Review case', kind: 'start-assessment' }],
  'cfa-constructed-response': [{ id: 'score-rubric', label: 'Score rubric', kind: 'start-assessment' }],
  mock: [{ id: 'start-level1-mock', label: 'Start mock', kind: 'start-assessment', path: '/cfa/level1/mock' }],
  'level-mock': [{ id: 'resume-level-mock', label: 'Resume mock', kind: 'start-assessment' }],
  review: [{ id: 'open-review', label: 'Open review', kind: 'navigate', path: '/review', commandId: 'command:review' }],
  vault: [{ id: 'export-vault', label: 'Export backup', kind: 'backup', commandId: 'action:backup' }],
  analytics: [{ id: 'export-analytics', label: 'Export analytics', kind: 'export' }],
  system: [
    { id: 'encrypted-backup', label: 'Encrypted backup', kind: 'backup', commandId: 'action:backup' },
    { id: 'cache-critical-routes', label: 'Cache critical routes', kind: 'cache' },
    { id: 'repair-preview', label: 'Repair preview', kind: 'repair', commandId: 'action:repair' },
  ],
};

function breadcrumbsFor(route: BaseAppRoute) {
  const root = [{ label: 'Dashboard', path: '/' }];
  if (route.id === 'dashboard') return root;
  const domainCrumb =
    route.domain === 'cfa'
      ? { label: 'CFA', path: '/cfa' }
      : route.domain === 'quant'
        ? { label: 'Quant', path: '/quant' }
        : route.domain === 'excel'
          ? { label: 'Excel', path: '/excel' }
          : route.domain === 'ops'
            ? { label: 'Operations', path: '/system' }
            : route.domain === 'vault'
              ? { label: 'Vault', path: '/vault' }
              : null;
  return [...root, ...(domainCrumb && domainCrumb.path !== route.path ? [domainCrumb] : []), { label: routeLabels[route.id] || route.expectedText, path: route.smokeRoute || route.screenshotRoute || route.path }];
}

function keyboardHelpFor(route: { id: AppRouteId }, scopes: string[]): AppRoute['keyboardHelp'] {
  return scopes.map((scope) => ({
    scope,
    keys:
      route.id === 'cfa-quiz' || route.id === 'mock' || route.id === 'level-mock'
        ? ['1-4', 'f', 'enter']
        : route.id === 'system' || route.id === 'vault'
          ? ['tab', 'enter', 'esc']
          : ['/', 'k', 'tab'],
    label: scope.replace(/-/g, ' '),
  }));
}

function qaStatesFor(route: { id: AppRouteId; preferredLayout: PreferredLayout }): AppRoute['qaStates'] {
  const viewports: QaViewport[] = [320, 375, 414, 768, 1024, 1440];
  const states = [{ id: 'default', label: 'Default route state', viewports }];
  if (route.preferredLayout === 'assessment') states.push({ id: 'active-assessment', label: 'Active assessment state', viewports });
  if (route.id === 'system' || route.id === 'vault') states.push({ id: 'dialog-open', label: 'Dialog or action state', viewports });
  if (route.id === 'dashboard' || route.id === 'review') states.push({ id: 'empty-loading-error', label: 'Loading, empty, and error states', viewports });
  return states;
}

export const appRoutes: AppRoute[] = baseAppRoutes.map((route, index) => ({
  ...route,
  navOrder: index + 1,
  navLabel: routeLabels[route.id] || route.expectedText,
  searchGroup: route.navGroup,
  offlineCritical: offlineCriticalRouteIds.has(route.id),
  keyboardScopes: keyboardScopesByRoute[route.id] || ['route'],
  breadcrumbs: breadcrumbsFor(route),
  routeActions: routeActionsByRoute[route.id] || [],
  keyboardHelp: keyboardHelpFor(route, keyboardScopesByRoute[route.id] || ['route']),
  offlineWarmup: offlineCriticalRouteIds.has(route.id)
    ? { path: route.smokeRoute || route.screenshotRoute || route.path, priority: route.id === 'dashboard' || route.domain === 'cfa' ? 'critical' : 'standard' }
    : undefined,
  preloadStrategy: offlineCriticalRouteIds.has(route.id) ? 'eager' : route.preferredLayout === 'tool' ? 'interaction' : 'idle',
  qaStates: qaStatesFor(route),
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
    title: 'Notes, Bookmarks & Source Vault',
    subtitle: 'Local notes, saved items, and private CFA source search',
    type: 'Tool',
    path: '/vault',
    keywords: ['notes bookmarks local vault saved source qvsource cfa documents private search'],
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
  { id: 'command:today', title: 'Today — Focused Plan', subtitle: 'One-screen "what to do next" driven by the Study Director', path: '/today', keywords: ['today focused next action study director plan'] },
  { id: 'command:knowledge-graph', title: 'Open Knowledge Graph', subtitle: 'Interactive map of CFA topics across Levels I → III', path: '/knowledge-graph', keywords: ['knowledge graph topics map levels canvas'] },
  { id: 'action:backup', title: 'Export Vault Backup', subtitle: 'Download all local data as JSON', path: '/vault', keywords: ['export backup vault json local data'], action: 'backup' },
  { id: 'action:repair', title: 'Repair Local Vault', subtitle: 'Rebuild indexes and clean corrupted rows', path: '/review', keywords: ['repair vault rebuild indexes corrupted rows'], action: 'repair' },
  { id: 'action:theme', title: 'Toggle Theme', subtitle: 'Switch light or dark mode', path: '/', keywords: ['toggle theme light dark'], action: 'theme' },
  { id: 'command:style', title: 'Open Style Gallery', subtitle: 'Tokens, primitives, and the visual system', path: '/style', keywords: ['style gallery tokens primitives design system colors typography'] },
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

// ──────────────────────────────────────────────────────────────────────────
// QA-1 / K4-0 — LSAT routes for the QA gates (visual + a11y + smoke).
//
// The vendored LSAT domain is served by the SAME production build at /lsat/*
// (src/main.jsx mounts LsatRoot under a `<BrowserRouter basename="/lsat">`, so
// the LSAT manifest's app-relative paths map to host URLs by prefixing /lsat:
// "/" → "/lsat", "/srs" → "/lsat/srs", etc.). These derived arrays let the gate
// scripts crawl that surface without re-listing routes: paths/labels come from
// the LSAT manifest (the single source of truth), and only the per-route
// `expectedText` — a deterministic body-text anchor the gates wait for — lives
// here, since the LSAT manifest carries no such field.
//
// CURATION: we cover the study-mode list/detail/setup pages whose page header
// renders the same heading across every load/empty/loaded branch (so the frame
// + axe scan are reproducible offline, with no sidecar). We intentionally skip:
//   - "/dashboard" — its <PageLayout title> flips between "Welcome back" /
//     "Dashboard" / "First light" by state, so no single stable anchor exists;
//   - "/notebook" — an alias whose canonicalPath is "/" (same page as "/lsat");
//   - the full-bleed exam runners (/take, /exam, /blind-review, /popout) — they
//     need a started session to render and are the K4-11 high-risk batch.
const LSAT_ROUTE_PREFIX = '/lsat';

// Deterministic body-text anchor per LSAT manifest path. A path present here is
// included in the gates; one absent (or that maps to a non-stable heading) is
// skipped. Keyed by the LSAT-manifest path (app-relative, no /lsat prefix).
const lsatRouteExpectedText: Record<string, string> = {
  '/': 'Notebook OS',
  '/practice': 'Practice',
  '/preptests': 'PrepTests',
  '/drills': 'Drills',
  '/playlists': 'Smart sets',
  '/srs': 'SRS',
  '/review': 'Review',
  '/analytics': 'Analytics',
  '/tutor': 'Tutor',
  '/rc-lab': 'RC Lab',
  '/bank': 'Question bank',
  '/content-ops': 'Content Ops',
  '/quarantine': 'Generation quarantine',
  '/import': 'Import a PrepTest',
  '/settings': 'Settings',
};

// Stable, file-safe id for a baseline filename (tests/visual-baselines/<id>-…).
function lsatRouteId(path: string): string {
  const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
  return `lsat-${slug}`;
}

// Host URL for an LSAT manifest path (the basename prefix the host serves under).
function lsatHostPath(path: string): string {
  return path === '/' ? LSAT_ROUTE_PREFIX : `${LSAT_ROUTE_PREFIX}${path}`;
}

// Drive both the screenshot + smoke LSAT sets off ONE filtered manifest pass so
// they never drift, and so a manifest path that loses its `expectedText` anchor
// drops out of every gate together. `canonicalPath` aliases (e.g. "/notebook")
// are excluded — only their canonical target ("/") is crawled.
const lsatGateRoutes = lsatRouteManifest
  .filter((entry) => !entry.canonicalPath && entry.path in lsatRouteExpectedText)
  .map((entry) => ({
    id: lsatRouteId(entry.path),
    manifestPath: entry.path,
    path: lsatHostPath(entry.path),
    expectedText: lsatRouteExpectedText[entry.path],
    label: entry.label,
  }));

export const lsatSmokeRoutes: Array<[string, string]> = lsatGateRoutes.map(
  (route) => [route.path, route.expectedText] as [string, string],
);

export const lsatScreenshotRoutes = lsatGateRoutes.map((route) => ({
  id: route.id,
  path: route.path,
  expectedText: route.expectedText,
  domain: 'lsat' as const,
  // LSAT pages render under their own accent/layout chrome today (pre-K4); the
  // gate only needs these fields to exist, so we tag them as a tool surface.
  accentRole: 'study' as const,
  preferredLayout: 'tool' as const,
  viewports: ['desktop', 'mobile'] as const,
}));
