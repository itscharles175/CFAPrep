// QA-1 / K4-0: read the vendored LSAT route manifest so the QA gates (visual,
// a11y, smoke) can crawl the /lsat/* surface, not just host routes. We import the
// SOURCE OF TRUTH for LSAT paths/labels rather than re-listing them, so a path
// rename in the LSAT manifest is caught here at build time. The manifest's own
// imports are inert for the gate (lucide icons + lazy `import()` arrows that are
// never invoked at module-eval time), so importing it from a plain node script
// via the TS loader is safe.
import { routeManifest as lsatRouteManifest } from '../domains/lsat/lib/routeManifest';
import type { RouteManifestEntry as LsatRouteManifestEntry } from '../domains/lsat/lib/routeManifest';
// K4-5: the host manifest addresses icons by string key; the LSAT manifest
// carries lucide components. We import the SAME component set the LSAT manifest
// uses to build a component->key map (translate, don't re-declare). These are
// tree-shakeable references used only inside a Map literal at module-eval time.
import {
  BarChart3,
  BookMarked,
  BookOpen,
  BrainCircuit,
  Clock,
  Database,
  Download,
  Flag,
  Library,
  ListMusic,
  RotateCcw,
  Settings,
  ShieldCheck,
  Target,
} from 'lucide-react';

/** K4-5: the LSAT manifest's `group` union, re-stated for the host mappers. */
type RouteManifestEntryGroup = LsatRouteManifestEntry['group'];

export type RouteBoundary = 'page' | 'domain';
// K4-5: `'lsat'` joins the host domains so the merged route tree can carry the
// vendored LSAT surface alongside CFA/Quant/Excel. (Pre-K4 the LSAT plane has
// its own manifest + shell; this domain tag is DATA only — it does not mount any
// router. See `lsatAppRoutes` / `routeTree` below.)
export type RouteDomain = 'home' | 'cfa' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'tool' | 'lsat';
export type RouteAccentRole = 'study' | 'exam' | 'quant' | 'excel' | 'vault' | 'analytics' | 'ops' | 'danger';
export type PreferredLayout = 'dashboard' | 'learning' | 'assessment' | 'tool' | 'ops';
export type StudyWorkspace = 'today' | 'learn' | 'practice' | 'review' | 'progress' | 'library' | 'utility';
export type RouteActionKind = 'navigate' | 'backup' | 'repair' | 'cache' | 'start-assessment' | 'open-drawer' | 'export';
export type PreloadStrategy = 'eager' | 'idle' | 'interaction' | 'manual';
export type QaViewport = 320 | 375 | 414 | 768 | 1024 | 1440;

/**
 * K4-5: study/test/ both, mirroring the LSAT shell's `AppMode` plus its
 * `hideInTest` flag. A host route is implicitly `'both'`; an LSAT route carries
 * the mode it should appear in so the future unified nav can honor Test Mode
 * (which hides the LSAT `hideInTest` routes) without re-deriving it.
 */
export type AppRouteMode = 'study' | 'test' | 'both';

export type HostRouteId =
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
  | 'today-alias'
  | 'knowledge-graph'
  | 'style'
  | 'leeches'
  | 'tutor-workspace'
  | 'preferences';

/**
 * K4-5: ids for the merged LSAT surface. Each is the LSAT manifest path slug
 * prefixed with `lsat-` so it can never collide with a `HostRouteId`. Dynamic
 * LSAT routes (take/exam/blind-review/etc.) are included so the merged tree is a
 * faithful map of the LSAT shell's `<Routes>`.
 */
export type LsatRouteId =
  | 'lsat-home'
  | 'lsat-dashboard'
  | 'lsat-practice'
  | 'lsat-preptests'
  | 'lsat-drills'
  | 'lsat-playlists'
  | 'lsat-tutor'
  | 'lsat-notebook'
  | 'lsat-rc-lab'
  | 'lsat-review'
  | 'lsat-review-history'
  | 'lsat-srs'
  | 'lsat-analytics'
  | 'lsat-bank'
  | 'lsat-content-ops'
  | 'lsat-quarantine'
  | 'lsat-import'
  | 'lsat-settings'
  | 'lsat-bank-tag-review'
  | 'lsat-analytics-type'
  | 'lsat-analytics-pt'
  | 'lsat-explanation'
  | 'lsat-take-section'
  | 'lsat-take-session'
  | 'lsat-exam'
  | 'lsat-blind-review'
  | 'lsat-popout-passage';

export type AppRouteId = HostRouteId | LsatRouteId;

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
  /** Primary StudyVault workspace that owns this route in navigation and search. */
  workspace: StudyWorkspace;
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
  // ── K4-5: LSAT-carried metadata (all OPTIONAL; host routes leave them unset) ──
  /** ⌘K command label (LSAT manifest's `commandLabel`, e.g. "Go to SRS"). */
  commandLabel?: string;
  /** Free-text search keywords (LSAT manifest's `keywords`). */
  keywords?: string[];
  /** When true, hidden from nav/search while in Test Mode (LSAT `hideInTest`). */
  hideInTest?: boolean;
  /** Capability gate key (LSAT manifest's `capability`, e.g. "notebook_os"). */
  capability?: string;
  /**
   * Canonical target for an alias route (LSAT manifest's `canonicalPath`). Stored
   * here ALREADY `/lsat`-prefixed so it matches this entry's `path` space.
   */
  canonicalPath?: string;
  /** Which app mode this route belongs to. Host routes are implicitly `'both'`. */
  appMode?: AppRouteMode;
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
  { id: 'dashboard', path: '/progress/overview', expectedText: 'Progress', domain: 'analytics', navGroup: 'tools', iconKey: 'home', accentRole: 'analytics', preferredLayout: 'dashboard', workspace: 'progress', smokeRoute: '/progress/overview', screenshotRoute: '/progress/overview' },
  { id: 'cfa-dashboard', path: '/cfa', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa', domain: 'cfa', navGroup: 'domains', iconKey: 'graduation-cap', accentRole: 'exam', preferredLayout: 'dashboard', workspace: 'learn', smokeRoute: '/cfa', screenshotRoute: '/cfa' },
  { id: 'cfa-module', path: '/cfa/:level/:topic', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-module', domain: 'cfa', navGroup: 'domains', iconKey: 'book-open', accentRole: 'exam', preferredLayout: 'learning', workspace: 'learn', smokeRoute: '/cfa/level1/fixed-income', screenshotRoute: '/cfa/level1/fixed-income' },
  { id: 'cfa-quiz', path: '/cfa/:level/:topic/quiz', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-quiz', domain: 'cfa', navGroup: 'practice', iconKey: 'target', accentRole: 'exam', preferredLayout: 'assessment', workspace: 'practice', smokeRoute: '/cfa/level1/fixed-income/quiz', screenshotRoute: '/cfa/level1/fixed-income/quiz' },
  { id: 'cfa-vignette', path: '/cfa/:level/:topic/vignette', expectedText: 'CFA', boundary: 'domain', boundaryName: 'cfa-vignette', domain: 'cfa', navGroup: 'practice', iconKey: 'layers', accentRole: 'exam', preferredLayout: 'assessment', workspace: 'practice', smokeRoute: '/cfa/level1/fixed-income/vignette', screenshotRoute: '/cfa/level2/equity/vignette' },
  { id: 'cfa-constructed-response', path: '/cfa/:level/:topic/constructed-response', expectedText: 'LEVEL III RESPONSE', boundary: 'domain', boundaryName: 'cfa-cr', domain: 'cfa', navGroup: 'practice', iconKey: 'pen-line', accentRole: 'exam', preferredLayout: 'assessment', workspace: 'practice', screenshotRoute: '/cfa/level3/performance/constructed-response' },
  { id: 'quant-dashboard', path: '/quant', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant', domain: 'quant', navGroup: 'domains', iconKey: 'brain-circuit', accentRole: 'quant', preferredLayout: 'dashboard', workspace: 'learn', smokeRoute: '/quant', screenshotRoute: '/quant' },
  { id: 'quant-module', path: '/quant/:module', expectedText: 'Quant', boundary: 'domain', boundaryName: 'quant-module', domain: 'quant', navGroup: 'domains', iconKey: 'cpu', accentRole: 'quant', preferredLayout: 'tool', workspace: 'learn', smokeRoute: '/quant/risk-management', screenshotRoute: '/quant/risk-management' },
  { id: 'excel-dashboard', path: '/excel', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel', domain: 'excel', navGroup: 'domains', iconKey: 'table-2', accentRole: 'excel', preferredLayout: 'dashboard', workspace: 'learn', smokeRoute: '/excel', screenshotRoute: '/excel' },
  { id: 'excel-module', path: '/excel/:module', expectedText: 'Excel', boundary: 'domain', boundaryName: 'excel-module', domain: 'excel', navGroup: 'domains', iconKey: 'file-spreadsheet', accentRole: 'excel', preferredLayout: 'tool', workspace: 'learn', smokeRoute: '/excel/fundamentals', screenshotRoute: '/excel/dcf-modeling' },
  { id: 'calculators', path: '/calculators', expectedText: 'Calculators', domain: 'tool', navGroup: 'tools', iconKey: 'calculator', accentRole: 'study', preferredLayout: 'tool', workspace: 'library', smokeRoute: '/calculators', screenshotRoute: '/calculators' },
  { id: 'formulas', path: '/formulas', expectedText: 'Formula', domain: 'tool', navGroup: 'tools', iconKey: 'library', accentRole: 'study', preferredLayout: 'tool', workspace: 'library', screenshotRoute: '/formulas' },
  { id: 'review', path: '/review', expectedText: 'Review', domain: 'vault', navGroup: 'tools', iconKey: 'inbox', accentRole: 'vault', preferredLayout: 'dashboard', workspace: 'review', smokeRoute: '/review', screenshotRoute: '/review' },
  { id: 'vault', path: '/vault', expectedText: 'Vault', domain: 'vault', navGroup: 'tools', iconKey: 'notebook-tabs', accentRole: 'vault', preferredLayout: 'tool', workspace: 'library', smokeRoute: '/vault', screenshotRoute: '/vault' },
  { id: 'flashcards', path: '/flashcards', expectedText: 'Flashcards', domain: 'tool', navGroup: 'practice', iconKey: 'badge-check', accentRole: 'study', preferredLayout: 'assessment', workspace: 'practice', smokeRoute: '/flashcards', screenshotRoute: '/flashcards' },
  { id: 'mock', path: '/cfa/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', workspace: 'practice', smokeRoute: '/cfa/mock' },
  { id: 'level-mock', path: '/cfa/:level/mock', expectedText: 'Mock', domain: 'cfa', navGroup: 'practice', iconKey: 'clipboard-list', accentRole: 'exam', preferredLayout: 'assessment', workspace: 'practice', screenshotRoute: '/cfa/level3/mock' },
  { id: 'analytics', path: '/analytics', expectedText: 'Analytics', domain: 'analytics', navGroup: 'tools', iconKey: 'bar-chart-3', accentRole: 'analytics', preferredLayout: 'dashboard', workspace: 'progress', smokeRoute: '/analytics', screenshotRoute: '/analytics' },
  { id: 'content-ops', path: '/content-ops', expectedText: 'Content Operations', domain: 'ops', navGroup: 'ops', iconKey: 'file-search', accentRole: 'ops', preferredLayout: 'ops', workspace: 'utility', smokeRoute: '/content-ops', screenshotRoute: '/content-ops' },
  { id: 'system', path: '/system', expectedText: 'System', domain: 'ops', navGroup: 'ops', iconKey: 'hard-drive', accentRole: 'ops', preferredLayout: 'ops', workspace: 'utility', smokeRoute: '/system', screenshotRoute: '/system' },
  { id: 'today', path: '/', expectedText: 'Today', domain: 'home', navGroup: 'home', iconKey: 'sun', accentRole: 'study', preferredLayout: 'dashboard', workspace: 'today', smokeRoute: '/', screenshotRoute: '/' },
  { id: 'today-alias', path: '/today', expectedText: 'Today', domain: 'home', navGroup: 'home', iconKey: 'sun', accentRole: 'study', preferredLayout: 'dashboard', workspace: 'today', canonicalPath: '/' },
  { id: 'knowledge-graph', path: '/knowledge-graph', expectedText: 'Knowledge Graph', domain: 'analytics', navGroup: 'tools', iconKey: 'network', accentRole: 'analytics', preferredLayout: 'dashboard', workspace: 'progress', smokeRoute: '/knowledge-graph', screenshotRoute: '/knowledge-graph' },
  { id: 'style', path: '/style', expectedText: 'Style', domain: 'tool', navGroup: 'tools', iconKey: 'palette', accentRole: 'study', preferredLayout: 'tool', workspace: 'utility', smokeRoute: '/style', screenshotRoute: '/style' },
  { id: 'leeches', path: '/leeches', expectedText: 'Leeches & Gaps', domain: 'vault', navGroup: 'practice', iconKey: 'flag', accentRole: 'vault', preferredLayout: 'dashboard', workspace: 'review' },
  { id: 'tutor-workspace', path: '/library/tutor', expectedText: 'Tutor Workspace', domain: 'vault', navGroup: 'tools', iconKey: 'brain-circuit', accentRole: 'vault', preferredLayout: 'learning', workspace: 'library' },
  { id: 'preferences', path: '/preferences', expectedText: 'Preferences', domain: 'tool', navGroup: 'tools', iconKey: 'settings', accentRole: 'study', preferredLayout: 'tool', workspace: 'utility' },
];

const routeLabels: Partial<Record<AppRouteId, string>> = {
  dashboard: 'Progress',
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
  'today-alias': 'Today',
  'knowledge-graph': 'Knowledge Graph',
  style: 'Style Gallery',
  leeches: 'Leeches & Gaps',
  'tutor-workspace': 'Tutor Workspace',
  preferences: 'Preferences',
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
  'today-alias',
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
  const root = [{ label: 'Today', path: '/' }];
  if (route.id === 'today' || route.id === 'today-alias') return root;
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
    id: 'tool:tutor-workspace',
    title: 'Tutor Workspace',
    subtitle: 'Read sources, ask cited questions, annotate, and generate practice',
    type: 'Workspace',
    path: '/library/tutor',
    keywords: ['tutor sources citations notes annotations practice generation lm studio'],
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
  { id: 'command:tutor-workspace', title: 'Open Tutor Workspace', subtitle: 'Source-linked reading, notes, tutoring, and practice generation', path: '/library/tutor', keywords: ['library tutor sources citations notes practice generate'] },
  { id: 'command:knowledge-graph', title: 'Open Knowledge Graph', subtitle: 'Interactive map of CFA topics across Levels I → III', path: '/knowledge-graph', keywords: ['knowledge graph topics map levels canvas'] },
  { id: 'action:backup', title: 'Open Encrypted Backup', subtitle: 'Create a passphrase-protected local vault export', path: '/system', keywords: ['export backup vault encrypted passphrase local data'], action: 'backup' },
  { id: 'action:repair', title: 'Repair Local Vault', subtitle: 'Rebuild indexes and clean corrupted rows', path: '/review', keywords: ['repair vault rebuild indexes corrupted rows'], action: 'repair' },
  { id: 'action:theme', title: 'Toggle Theme', subtitle: 'Switch light or dark mode', path: '/', keywords: ['toggle theme light dark'], action: 'theme' },
  { id: 'command:preferences', title: 'Open Preferences', subtitle: 'Appearance, layout density, and reading aids', path: '/preferences', keywords: ['settings preferences appearance theme reading density dyslexia bionic spacing accessibility'] },
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

// ──────────────────────────────────────────────────────────────────────────
// K4-5 — MERGED ROUTE TREE (Phase 1 of Keystone K4: full UI unification).
//
// This block builds the LSAT surface as first-class `AppRoute` entries
// (`lsatAppRoutes`) and a merged read-only tree (`routeTree`) that unions the
// host `appRoutes` with the LSAT entries. It is DATA + NAV FOUNDATION ONLY:
//
//   * `appRoutes` (the host array App.jsx maps into <Route>s) is UNCHANGED — the
//     LSAT entries are a SEPARATE array. Merging them into `appRoutes` would
//     register phantom host routes (App.jsx iterates it) and is K4-7/K4-13.
//   * Every LSAT path is `/lsat`-prefixed (so "/srs" -> "/lsat/srs"), resolving
//     the "/" and "/dashboard" collisions the host already owns.
//   * LSAT `group` maps onto host `navGroup`/`searchGroup`; LSAT `icon` maps onto
//     host `iconKey` — we map, never duplicate. `commandLabel`/`keywords`/
//     `hideInTest`/`capability`/`canonicalPath`/`appMode` carry across.
// ──────────────────────────────────────────────────────────────────────────

// Stable `LsatRouteId` per LSAT manifest path (mirrors `LsatRouteId`'s union).
const lsatManifestRouteIds: Record<string, LsatRouteId> = {
  '/': 'lsat-home',
  '/dashboard': 'lsat-dashboard',
  '/practice': 'lsat-practice',
  '/preptests': 'lsat-preptests',
  '/drills': 'lsat-drills',
  '/playlists': 'lsat-playlists',
  '/tutor': 'lsat-tutor',
  '/notebook': 'lsat-notebook',
  '/rc-lab': 'lsat-rc-lab',
  '/review': 'lsat-review',
  '/review/history': 'lsat-review-history',
  '/srs': 'lsat-srs',
  '/analytics': 'lsat-analytics',
  '/bank': 'lsat-bank',
  '/content-ops': 'lsat-content-ops',
  '/quarantine': 'lsat-quarantine',
  '/import': 'lsat-import',
  '/settings': 'lsat-settings',
};

// LSAT manifest `group` -> host nav/search group + visual role. The host nav
// taxonomy ("domains"/"practice"/"tools"/"ops") is the target vocabulary; LSAT's
// "Practice"/"Insight"/"Setup"/"System" map onto it.
const lsatGroupToNavGroup: Record<RouteManifestEntryGroup, string> = {
  Practice: 'practice',
  Insight: 'tools',
  Setup: 'ops',
  System: 'ops',
};
const lsatGroupToAccentRole: Record<RouteManifestEntryGroup, RouteAccentRole> = {
  Practice: 'study',
  Insight: 'analytics',
  Setup: 'ops',
  System: 'ops',
};
const lsatGroupToLayout: Record<RouteManifestEntryGroup, PreferredLayout> = {
  Practice: 'assessment',
  Insight: 'dashboard',
  Setup: 'ops',
  System: 'ops',
};

// Lucide-icon component -> host `iconKey` string. The host manifest addresses
// icons by string key (resolved to a component by the sidebar); the LSAT
// manifest carries the component directly, so we translate by reference.
const lsatIconKeys = new Map<LsatRouteManifestEntry['icon'], string>([
  [BarChart3, 'bar-chart-3'],
  [BookMarked, 'book-marked'],
  [BookOpen, 'book-open'],
  [BrainCircuit, 'brain-circuit'],
  [Clock, 'clock'],
  [Database, 'database'],
  [Download, 'download'],
  [Flag, 'flag'],
  [Library, 'library'],
  [ListMusic, 'list-music'],
  [RotateCcw, 'rotate-ccw'],
  [Settings, 'settings'],
  [ShieldCheck, 'shield-check'],
  [Target, 'target'],
]);

// Deterministic body-text anchor for the dynamic + full-bleed LSAT routes that
// aren't in `lsatRouteExpectedText` (which only covers the stable shelled list
// pages). Used purely to satisfy the `AppRoute.expectedText` QA-gate field; the
// gate crawl itself still derives from `lsatGateRoutes` above, so these dynamic
// entries never enter the screenshot/smoke sets (they need a started session).
const lsatDynamicExpectedText: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/notebook': 'Notebook OS',
  '/tutor': 'Tutor',
  '/review/history': 'Session history',
  '/bank/tag-review': 'Tag review',
  '/analytics/type/:qType': 'Type analytics',
  '/analytics/pt/:ptId': 'PrepTest analytics',
  '/explanation/:questionId': 'Explanation',
  '/take/:sectionId': 'Timed section',
  '/take/session/:sessionId': 'Timed section',
  '/exam/:preptestId': 'Full exam',
  '/blind-review/:sessionId': 'Blind review',
  '/popout/passage': 'Passage',
};

function lsatExpectedTextFor(manifestPath: string): string {
  return lsatRouteExpectedText[manifestPath] ?? lsatDynamicExpectedText[manifestPath] ?? 'LSAT';
}

function lsatWorkspaceFor(id: LsatRouteId, navGroup: string): StudyWorkspace {
  if (id === 'lsat-review' || id === 'lsat-review-history' || id === 'lsat-srs' || id === 'lsat-blind-review') return 'review';
  if (id === 'lsat-analytics' || id === 'lsat-analytics-type' || id === 'lsat-analytics-pt') return 'progress';
  if (id === 'lsat-tutor' || id === 'lsat-notebook' || id === 'lsat-bank' || id === 'lsat-playlists' || id === 'lsat-explanation') return 'library';
  if (navGroup === 'practice') return 'practice';
  if (navGroup === 'ops') return 'utility';
  return 'learn';
}

// Breadcrumb trail for an LSAT entry: always rooted at the LSAT plane home
// (`/lsat` -> "LSAT Lab"), then the entry itself. Aliases and the home route
// collapse to a single crumb.
function lsatBreadcrumbsFor(hostPath: string, label: string): AppRoute['breadcrumbs'] {
  const root = { label: 'LSAT Lab', path: LSAT_ROUTE_PREFIX };
  if (hostPath === LSAT_ROUTE_PREFIX) return [root];
  return [root, { label, path: hostPath }];
}

// A static LSAT manifest entry -> AppRoute (study-mode list/detail/setup pages).
function lsatStaticAppRoute(entry: LsatRouteManifestEntry, navOrder: number): AppRoute {
  const id = lsatManifestRouteIds[entry.path];
  const navGroup = lsatGroupToNavGroup[entry.group];
  const hostPath = lsatHostPath(entry.path);
  const isHome = entry.path === '/';
  // Only the curated stable list pages get crawled by the QA gate (those in
  // `lsatRouteExpectedText`); carry their `/lsat` host path as the smoke /
  // screenshot anchor so the merged entry agrees with `lsatGateRoutes`.
  const isGated = !entry.canonicalPath && entry.path in lsatRouteExpectedText;
  return {
    id,
    path: hostPath,
    expectedText: lsatExpectedTextFor(entry.path),
    domain: 'lsat',
    navGroup,
    iconKey: lsatIconKeys.get(entry.icon) ?? 'book-open',
    accentRole: lsatGroupToAccentRole[entry.group],
    preferredLayout: lsatGroupToLayout[entry.group],
    workspace: lsatWorkspaceFor(id, navGroup),
    navOrder,
    navLabel: entry.label,
    searchGroup: navGroup,
    offlineCritical: false,
    keyboardScopes: ['route'],
    breadcrumbs: lsatBreadcrumbsFor(hostPath, entry.label),
    routeActions: [],
    keyboardHelp: [{ scope: 'route', keys: ['/', 'k', 'tab'], label: 'route' }],
    preloadStrategy: 'idle',
    qaStates: [{ id: 'default', label: 'Default route state', viewports: [320, 375, 414, 768, 1024, 1440] }],
    smokeRoute: isGated ? hostPath : undefined,
    screenshotRoute: isGated ? hostPath : undefined,
    commandLabel: entry.commandLabel,
    keywords: entry.keywords,
    hideInTest: entry.hideInTest,
    capability: entry.capability,
    // canonicalPath is `/lsat`-prefixed so it lives in this entry's path space.
    canonicalPath: entry.canonicalPath ? lsatHostPath(entry.canonicalPath) : undefined,
    appMode: entry.hideInTest ? 'study' : 'both',
  };
}

// Dynamic + full-bleed LSAT routes (not in the LSAT manifest, but real entries
// in the LSAT shell's <Routes> — see src/domains/lsat/App.tsx). They never enter
// the nav/search/gate surfaces; they exist so `routeTree` is a faithful map of
// every navigable LSAT URL for lookups (canonicalRoutePath, route-by-path).
interface LsatDynamicSpec {
  id: LsatRouteId;
  manifestPath: string; // app-relative LSAT path (pre-/lsat)
  navLabel: string;
  navGroup: string;
  accentRole: RouteAccentRole;
  preferredLayout: PreferredLayout;
  hideInTest?: boolean;
}

const lsatDynamicSpecs: LsatDynamicSpec[] = [
  { id: 'lsat-bank-tag-review', manifestPath: '/bank/tag-review', navLabel: 'Tag review', navGroup: 'ops', accentRole: 'ops', preferredLayout: 'ops', hideInTest: true },
  { id: 'lsat-analytics-type', manifestPath: '/analytics/type/:qType', navLabel: 'Type analytics', navGroup: 'tools', accentRole: 'analytics', preferredLayout: 'dashboard', hideInTest: true },
  { id: 'lsat-analytics-pt', manifestPath: '/analytics/pt/:ptId', navLabel: 'PrepTest analytics', navGroup: 'tools', accentRole: 'analytics', preferredLayout: 'dashboard', hideInTest: true },
  { id: 'lsat-explanation', manifestPath: '/explanation/:questionId', navLabel: 'Explanation', navGroup: 'tools', accentRole: 'analytics', preferredLayout: 'learning', hideInTest: true },
  { id: 'lsat-take-section', manifestPath: '/take/:sectionId', navLabel: 'Timed section', navGroup: 'practice', accentRole: 'study', preferredLayout: 'assessment' },
  { id: 'lsat-take-session', manifestPath: '/take/session/:sessionId', navLabel: 'Timed section', navGroup: 'practice', accentRole: 'study', preferredLayout: 'assessment' },
  { id: 'lsat-exam', manifestPath: '/exam/:preptestId', navLabel: 'Full exam', navGroup: 'practice', accentRole: 'study', preferredLayout: 'assessment' },
  { id: 'lsat-blind-review', manifestPath: '/blind-review/:sessionId', navLabel: 'Blind review', navGroup: 'tools', accentRole: 'analytics', preferredLayout: 'assessment', hideInTest: true },
  { id: 'lsat-popout-passage', manifestPath: '/popout/passage', navLabel: 'Passage', navGroup: 'tools', accentRole: 'study', preferredLayout: 'tool' },
];

function lsatDynamicAppRoute(spec: LsatDynamicSpec, navOrder: number): AppRoute {
  const hostPath = lsatHostPath(spec.manifestPath);
  return {
    id: spec.id,
    path: hostPath,
    expectedText: lsatExpectedTextFor(spec.manifestPath),
    domain: 'lsat',
    navGroup: spec.navGroup,
    iconKey: 'book-open',
    accentRole: spec.accentRole,
    preferredLayout: spec.preferredLayout,
    workspace: lsatWorkspaceFor(spec.id, spec.navGroup),
    navOrder,
    navLabel: spec.navLabel,
    searchGroup: spec.navGroup,
    offlineCritical: false,
    keyboardScopes: ['route'],
    breadcrumbs: lsatBreadcrumbsFor(hostPath, spec.navLabel),
    routeActions: [],
    keyboardHelp: [{ scope: 'route', keys: ['/', 'k', 'tab'], label: 'route' }],
    preloadStrategy: 'manual',
    qaStates: [{ id: 'default', label: 'Default route state', viewports: [320, 375, 414, 768, 1024, 1440] }],
    hideInTest: spec.hideInTest,
    appMode: spec.hideInTest ? 'study' : 'both',
  };
}

/**
 * The vendored LSAT surface as first-class `AppRoute` entries, every path
 * `/lsat`-prefixed. NOT fed into `appRoutes` (the host router array) — consumed
 * via `routeTree` + the merged helpers below. `navOrder` continues after the
 * host routes so a future unified sidebar can render one contiguous order.
 */
export const lsatAppRoutes: AppRoute[] = (() => {
  const hostMax = appRoutes.reduce((max, route) => Math.max(max, route.navOrder), 0);
  const statics = lsatRouteManifest.map((entry, index) => lsatStaticAppRoute(entry, hostMax + index + 1));
  const dynamics = lsatDynamicSpecs.map((spec, index) =>
    lsatDynamicAppRoute(spec, hostMax + statics.length + index + 1),
  );
  return [...statics, ...dynamics];
})();

/**
 * K4-5 merged tree: host routes + LSAT routes in one array. Read-only data for
 * unified nav/search/lookup. The host shell still mounts `appRoutes` ONLY (no
 * router change); this union is what the merged helpers below resolve against.
 */
export const routeTree: AppRoute[] = [...appRoutes, ...lsatAppRoutes];

/** Quick path -> route lookup over the merged tree (exact, static paths). */
const routeTreeByPath = new Map(routeTree.map((route) => [route.path, route]));

/** The merged route whose `path` exactly equals `path`, if any. */
export function routeByPath(path: string): AppRoute | undefined {
  return routeTreeByPath.get(path);
}

/**
 * Canonical path resolver over the merged tree: follows an alias entry's
 * `canonicalPath` (e.g. `/lsat/notebook` -> `/lsat`). Host routes have no
 * aliases, so they pass through unchanged.
 */
export function canonicalRoutePath(path: string): string {
  return routeTreeByPath.get(path)?.canonicalPath ?? path;
}

/** Friendly nav label for a merged-tree path (canonical-aware). */
export function routeLabel(path: string): string | undefined {
  return routeTreeByPath.get(canonicalRoutePath(path))?.navLabel;
}

/** Resolve a concrete URL to its owning route, including dynamic route patterns. */
export function routeForLocation(pathname: string): AppRoute | undefined {
  const cleanPath = pathname.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/';
  const exact = routeTreeByPath.get(cleanPath);
  if (exact) return exact;
  const inputSegments = cleanPath.split('/').filter(Boolean);
  return routeTree.find((route) => {
    const patternSegments = route.path.split('/').filter(Boolean);
    if (patternSegments.length !== inputSegments.length) return false;
    return patternSegments.every((segment, index) => segment.startsWith(':') || segment === inputSegments[index]);
  });
}

/** Resolve the primary workspace highlighted by a concrete URL. */
export function workspaceForLocation(pathname: string): StudyWorkspace {
  return routeForLocation(pathname)?.workspace ?? 'learn';
}

/**
 * ⌘K-style search rows derived from the merged tree's LSAT entries (host search
 * rows still come from `searchToolRoutes`/`commandRoutes`). Excludes aliases and
 * the dynamic/full-bleed routes (no `commandLabel`), so it mirrors the LSAT
 * shell's own command list, but with `/lsat`-prefixed paths.
 */
export const lsatSearchRoutes: SearchRoute[] = lsatAppRoutes
  .filter((route) => route.commandLabel && !route.canonicalPath)
  .map((route) => ({
    id: `lsat:${route.id}`,
    title: route.navLabel,
    subtitle: route.commandLabel as string,
    type: 'LSAT',
    path: route.path,
    keywords: route.keywords ?? [],
  }));
