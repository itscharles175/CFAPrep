import { useEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type SVGProps } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen, TrendingUp, Table2,
  Calculator, Library, ChevronDown, ChevronRight,
  PanelLeftClose, PanelLeft,
  GraduationCap, BarChart3, Shield, DollarSign,
  LineChart, Building2, Gem, PieChart, Layers,
  Binary, Sigma, Flame, GitBranch, Target, Cpu, BrainCircuit,
  FileSpreadsheet, Code, Gauge,
  Inbox, NotebookTabs, BadgeCheck, ClipboardList, FileSearch, HardDrive, Sun, Network,
  Scale, BookMarked, Clock, Database, Download, Flag, ListMusic, RotateCcw, Settings, ShieldCheck,
  Compass, Dumbbell, RefreshCw, ChartNoAxesCombined,
} from 'lucide-react';
import { excelModules, quantModules } from '../../data/catalog';
import { cfaLevels } from '../../domains/cfa/cfaLevels';
import { level3TopicBelongsToPathway } from '../../domains/cfa/cfaLevel3Pathways';
import { useLevel3Pathway } from '../../domains/cfa/useLevel3Pathway';
import { appRoutes, workspaceForLocation } from '../../routes/routeManifest';
import type { AppRoute, StudyWorkspace } from '../../routes/routeManifest';
import { buildLsatNavGroups, type LsatNavMode } from '../../lib/lsatNavSection';
import {
  contextSwitchHref,
  domainForLocation,
  rememberStudyContextRoute,
  stageStudyContextHandoff,
  stageStudyContextOrigin,
  type StudyDomain,
  useStudyContext,
  workspaceHref,
} from '../../lib/studyContext';
import StudyContextSelector from './StudyContextSelector';

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const cfaIconMap: Record<string, LucideIcon> = {
  ethics: Shield,
  'quant-methods': Sigma,
  economics: TrendingUp,
  fsa: FileSpreadsheet,
  corporate: Building2,
  equity: BarChart3,
  'fixed-income': DollarSign,
  derivatives: LineChart,
  alternatives: Gem,
  portfolio: PieChart,
};

const quantIconMap: Record<string, LucideIcon> = {
  probability: Binary,
  'linear-algebra': Layers,
  'stochastic-calc': Flame,
  'derivatives-pricing': LineChart,
  'risk-management': Target,
  'portfolio-optimization': PieChart,
};

const excelIconMap: Record<string, LucideIcon> = {
  fundamentals: Table2,
  'advanced-formulas': Sigma,
  'financial-functions': DollarSign,
  'dcf-modeling': TrendingUp,
  'vba-macros': Code,
};

const routeIconMap: Record<string, LucideIcon> = {
  inbox: Inbox,
  'notebook-tabs': NotebookTabs,
  'badge-check': BadgeCheck,
  'clipboard-list': ClipboardList,
  'bar-chart-3': BarChart3,
  calculator: Calculator,
  library: Library,
  'file-search': FileSearch,
  'hard-drive': HardDrive,
  sun: Sun,
  network: Network,
  // K4-6: icon keys carried by the merged LSAT routes (lsatAppRoutes). Mapped
  // here so the flag-gated LSAT section resolves the same lucide glyphs the
  // legacy LSAT rail uses.
  'book-open': BookOpen,
  'book-marked': BookMarked,
  'brain-circuit': BrainCircuit,
  clock: Clock,
  database: Database,
  download: Download,
  flag: Flag,
  'list-music': ListMusic,
  'rotate-ccw': RotateCcw,
  settings: Settings,
  'shield-check': ShieldCheck,
  target: Target,
};

const sidebarToolRouteIds = ['flashcards', 'mock', 'leeches', 'vault', 'tutor-workspace', 'formulas', 'calculators', 'knowledge-graph', 'content-ops', 'system', 'preferences'];
const sidebarToolRoutes: AppRoute[] = appRoutes
  .filter((route) => sidebarToolRouteIds.includes(route.id))
  .sort((a, b) => sidebarToolRouteIds.indexOf(a.id) - sidebarToolRouteIds.indexOf(b.id));

const primaryWorkspaces: Array<{ id: Exclude<StudyWorkspace, 'utility'>; label: string; icon: LucideIcon }> = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'learn', label: 'Learn', icon: Compass },
  { id: 'practice', label: 'Practice', icon: Dumbbell },
  { id: 'review', label: 'Review', icon: RefreshCw },
  { id: 'progress', label: 'Progress', icon: ChartNoAxesCombined },
  { id: 'library', label: 'Library', icon: Library },
];

interface SidebarSubItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface SidebarSectionProps {
  label: string;
  icon: LucideIcon;
  basePath: string;
  items: SidebarSubItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}

function SidebarSection({ label, icon: Icon, basePath, items, collapsed, onNavigate }: SidebarSectionProps) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(basePath);
  const [expanded, setExpanded] = useState(isActive);

  return (
    <div className="sidebar-section">
      <NavLink
        to={basePath}
        className={({ isActive: exact }) =>
          `sidebar-link ${exact || isActive ? 'active' : ''}`
        }
        end
        onClick={(e) => {
          if (!collapsed && items) {
            e.preventDefault();
            setExpanded(!expanded);
          } else {
            onNavigate?.();
          }
        }}
      >
        <Icon />
        {!collapsed && (
          <>
            <span style={{ flex: 1 }}>{label}</span>
            {items && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          </>
        )}
      </NavLink>

      {!collapsed && expanded && items && (
        <div className="sidebar-sub-links">
          <NavLink to={basePath} end onClick={onNavigate} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <Gauge size={14} />
            <span>Overview</span>
          </NavLink>
          {items.map((item) => (
            <NavLink
              key={item.id}
              to={`${basePath}/${item.id}`}
              onClick={onNavigate}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              <item.icon size={14} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * K4-6 — the unified shell's LSAT navigation section (Phase 1 of Keystone K4).
 *
 * Renders the vendored LSAT surface (from `lsatAppRoutes`) as ONE collapsible
 * host Sidebar section, its rows grouped by `navGroup` (Practice / Insight /
 * Setup) via `buildLsatNavGroups`, honoring the active `mode` (Test Mode hides
 * the `hideInTest` rows).
 *
 * The section header navigates to `/lsat` and the rows to their `/lsat/*` paths
 * inside the one host router (K4-7 unified the router; K4-13 made it the only
 * shell).
 */
function LsatSidebarSection({
  collapsed,
  mode = 'study',
  onNavigate,
}: {
  collapsed?: boolean;
  mode?: LsatNavMode;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const isActive = location.pathname === '/lsat' || location.pathname.startsWith('/lsat/');
  const [expanded, setExpanded] = useState(isActive);
  const groups = buildLsatNavGroups(mode);

  return (
    <div className="sidebar-section">
      <NavLink
        to="/lsat"
        className={`sidebar-link ${isActive ? 'active' : ''}`}
        onClick={(e) => {
          if (!collapsed) {
            e.preventDefault();
            setExpanded(!expanded);
          } else {
            onNavigate?.();
          }
        }}
      >
        <Scale />
        {!collapsed && (
          <>
            <span style={{ flex: 1 }}>LSAT</span>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </>
        )}
      </NavLink>

      {!collapsed && expanded && (
        <div className="sidebar-sub-links">
          {groups.map((group) => (
            <div key={group.group} className="sidebar-section">
              <div className="sidebar-section-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = routeIconMap[item.iconKey] || Gauge;
                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    onClick={onNavigate}
                    className={({ isActive: active }) => `sidebar-link ${active ? 'active' : ''}`}
                  >
                    <Icon size={14} />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  collapsed?: boolean;
  open?: boolean;
  mobileHidden?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  /**
   * K4-6: active LSAT mode (study/test). Consumed by the LSAT section to hide
   * `hideInTest` rows in Test Mode. Defaults to 'study'.
   */
  lsatMode?: LsatNavMode;
  /**
   * UB4: dedicated "close the mobile drawer" callback. Defaults to `onNavigate`
   * when omitted so the existing App shell wiring (which closes the drawer in
   * `onNavigate`) drives swipe-to-close without any caller change. Public API is
   * additive — desktop behaviour is unaffected.
   */
  onClose?: () => void;
}

// UB4: a leftward drag of at least this many px (with a dominant horizontal
// component) dismisses the off-canvas drawer. Tuned to feel intentional without
// fighting vertical nav scrolling.
const SWIPE_CLOSE_THRESHOLD = 56;
const CONTEXT_NAVIGATION_ANNOUNCEMENT_KEY = 'studyvault:context-navigation-announcement:v1';

function readContextNavigationAnnouncement(): string {
  try {
    const message = window.sessionStorage.getItem(CONTEXT_NAVIGATION_ANNOUNCEMENT_KEY) || '';
    window.sessionStorage.removeItem(CONTEXT_NAVIGATION_ANNOUNCEMENT_KEY);
    return message;
  } catch {
    return '';
  }
}

function persistContextNavigationAnnouncement(message: string) {
  try {
    window.sessionStorage.setItem(CONTEXT_NAVIGATION_ANNOUNCEMENT_KEY, message);
  } catch {
    // The mounted sidebar still announces in restrictive storage contexts.
  }
}

function clearContextNavigationAnnouncement() {
  try {
    window.sessionStorage.removeItem(CONTEXT_NAVIGATION_ANNOUNCEMENT_KEY);
  } catch {
    // This is only a cross-plane accessibility enhancement.
  }
}

export default function Sidebar({
  collapsed,
  open,
  mobileHidden = false,
  onToggle,
  onNavigate,
  onClose,
  lsatMode = 'study',
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [studyContext, updateStudyContext] = useStudyContext();
  const [activePathway, setActivePathway] = useLevel3Pathway();
  const activeWorkspace = workspaceForLocation(location.pathname);
  const pendingRouteSync = useRef<{ domain: StudyDomain; level?: typeof studyContext.cfaLevel } | null>(null);
  const [navigationAnnouncement, setNavigationAnnouncement] = useState(readContextNavigationAnnouncement);

  useEffect(() => {
    const routeDomain = domainForLocation(location.pathname);
    const levelMatch = location.pathname.match(/^\/cfa\/(level[123])(?:\/|$)/)?.[1];
    const pending = pendingRouteSync.current;
    if (pending) {
      const pendingDomainReached = routeDomain === pending.domain;
      const pendingLevelReached = !pending.level || levelMatch === pending.level;
      if (!pendingDomainReached || !pendingLevelReached) return;
      pendingRouteSync.current = null;
    }
    const patch = {
      ...(routeDomain && routeDomain !== studyContext.domain ? { domain: routeDomain } : {}),
      ...(levelMatch && levelMatch !== studyContext.cfaLevel ? { cfaLevel: levelMatch as typeof studyContext.cfaLevel } : {}),
    };
    if (Object.keys(patch).length) updateStudyContext(patch);
  }, [location.pathname, studyContext.cfaLevel, studyContext.domain, updateStudyContext]);

  useEffect(() => {
    const routeDomain = domainForLocation(location.pathname) ?? studyContext.domain;
    rememberStudyContextRoute(routeDomain, activeWorkspace, location.pathname + location.search + location.hash);
  }, [activeWorkspace, location.hash, location.pathname, location.search, studyContext.domain]);

  const selectedCfaLevel = cfaLevels.find((level) => level.id === studyContext.cfaLevel) || cfaLevels[0];
  const selectedCfaTopics = selectedCfaLevel.topics.filter(
    (topic) => studyContext.cfaLevel !== 'level3' || level3TopicBelongsToPathway(topic.id, activePathway),
  );

  function focusMainAfterNavigation() {
    window.requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  }

  function announceAndNavigate(destination: string, message: string, pending: { domain: StudyDomain; level?: typeof studyContext.cfaLevel } | null) {
    pendingRouteSync.current = pending;
    const sourceIsLsat = domainForLocation(location.pathname) === 'lsat';
    const destinationIsLsat = domainForLocation(destination) === 'lsat';
    if (sourceIsLsat !== destinationIsLsat) persistContextNavigationAnnouncement(message);
    else clearContextNavigationAnnouncement();
    setNavigationAnnouncement(message);
    navigate(destination);
    onNavigate?.();
    focusMainAfterNavigation();
  }

  function handleDomainChange(domain: StudyDomain) {
    if (domain === studyContext.domain) return;
    const sourceRoute = location.pathname + location.search + location.hash;
    const sourceDomainIsLsat = domainForLocation(location.pathname) === 'lsat';
    rememberStudyContextRoute(studyContext.domain, activeWorkspace, sourceRoute);
    const nextContext = updateStudyContext({ domain });
    const destination = contextSwitchHref(activeWorkspace, nextContext);
    const destinationDomain = domainForLocation(destination);
    const destinationIsLsat = destinationDomain === 'lsat';
    if (sourceDomainIsLsat !== destinationIsLsat) {
      // The host and LSAT route trees can unmount in either order. Persist the
      // selection for the destination before navigation so Review/Progress do
      // not re-open with the source curriculum after their generic host handoff.
      stageStudyContextHandoff(nextContext);
      if (destinationIsLsat) stageStudyContextOrigin(studyContext, sourceRoute);
    }
    announceAndNavigate(
      destination,
      `Switched to ${domain === 'cfa' ? 'CFA' : domain === 'lsat' ? 'LSAT' : domain === 'quant' ? 'Quant' : 'Excel'} ${activeWorkspace}.`,
      destinationDomain ? { domain } : null,
    );
  }

  function handleCfaLevelChange(level: typeof studyContext.cfaLevel) {
    if (level === studyContext.cfaLevel) return;
    const nextLevel = cfaLevels.find((candidate) => candidate.id === level) || cfaLevels[0];
    const firstTopic = nextLevel.topics.find(
      (topic) => level !== 'level3' || level3TopicBelongsToPathway(topic.id, activePathway),
    );
    const destination = activeWorkspace === 'practice'
      ? `/cfa/${level}/mock`
      : firstTopic
        ? `/cfa/${level}/${firstTopic.id}`
        : '/cfa';
    rememberStudyContextRoute('cfa', activeWorkspace, location.pathname + location.search + location.hash);
    updateStudyContext({ domain: 'cfa', cfaLevel: level });
    announceAndNavigate(
      destination,
      `Switched to CFA ${level === 'level1' ? 'Level I' : level === 'level2' ? 'Level II' : 'Level III'} ${activeWorkspace}.`,
      { domain: 'cfa', level },
    );
  }
  // UB4: swipe-to-close. We track the pointer-down origin and, on release,
  // close the drawer when the gesture is a deliberate leftward swipe. Falls back
  // to `onNavigate` so the current shell (which uses onNavigate to close) works
  // unchanged. Pointer events cover touch + pen + mouse-drag uniformly.
  const closeDrawer = onClose ?? onNavigate;
  const swipeOrigin = useRef<{ x: number; y: number; id: number } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    // Only arm the gesture while the drawer is the active off-canvas overlay.
    if (!open || event.pointerType === 'mouse') return;
    swipeOrigin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLElement>) {
    const origin = swipeOrigin.current;
    swipeOrigin.current = null;
    if (!origin || origin.id !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    // Dominant leftward horizontal travel past the threshold = dismiss.
    if (dx <= -SWIPE_CLOSE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      closeDrawer?.();
    }
  }

  return (
    <aside
      id="main-sidebar"
      className={`sidebar ${collapsed ? 'collapsed' : ''} ${open ? 'open' : ''}`}
      role="complementary"
      aria-label="Main navigation sidebar"
      hidden={mobileHidden}
      inert={mobileHidden ? true : undefined}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={() => {
        swipeOrigin.current = null;
      }}
    >
      <p className="sr-only" role="status" aria-live="polite">{navigationAnnouncement}</p>
      <div className="sidebar-header">
        <div className="sidebar-logo">S</div>
        {!collapsed && <span className="sidebar-title">StudyVault</span>}
        <button
          className="btn-icon btn-ghost"
          onClick={onToggle}
          style={{ marginLeft: 'auto' }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      {!collapsed && (
        <StudyContextSelector
          context={studyContext}
          pathway={activePathway}
          onContextChange={updateStudyContext}
          onDomainChange={handleDomainChange}
          onLevelChange={handleCfaLevelChange}
          onPathwayChange={setActivePathway}
        />
      )}

      <nav className="sidebar-nav" aria-label="Primary navigation">
        <div className="sidebar-section workspace-nav">
          {primaryWorkspaces.map((workspace) => {
            const Icon = workspace.icon;
            const active = activeWorkspace === workspace.id;
            return (
              <NavLink
                key={workspace.id}
                to={workspaceHref(workspace.id, studyContext)}
                end
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={`sidebar-link ${active ? 'active' : ''}`}
              >
                <Icon />
                {!collapsed && <span>{workspace.label}</span>}
              </NavLink>
            );
          })}
        </div>

        {!collapsed && (
          <details className="sidebar-more">
            <summary>
              <Settings aria-hidden="true" />
              <span>Utilities &amp; more</span>
              <ChevronDown className="sidebar-more-chevron" aria-hidden="true" />
            </summary>
            <div className="sidebar-more-panel">
              <div className="sidebar-section-label">Current track</div>
              {studyContext.domain === 'cfa' && (
                <SidebarSection
                  label={`CFA ${studyContext.cfaLevel === 'level1' ? 'Level I' : studyContext.cfaLevel === 'level2' ? 'Level II' : 'Level III'}`}
                  icon={GraduationCap}
                  basePath="/cfa"
                  items={selectedCfaTopics.map((topic) => ({ id: `${studyContext.cfaLevel}/${topic.id}`, label: topic.label, icon: cfaIconMap[topic.id] || BookOpen }))}
                  onNavigate={onNavigate}
                />
              )}
              {studyContext.domain === 'quant' && (
                <SidebarSection label="Quant Finance" icon={BrainCircuit} basePath="/quant" items={quantModules.map((module) => ({ id: module.id, label: module.label, icon: quantIconMap[module.id] || Cpu }))} onNavigate={onNavigate} />
              )}
              {studyContext.domain === 'excel' && (
                <SidebarSection label="Excel Training" icon={Table2} basePath="/excel" items={excelModules.map((module) => ({ id: module.id, label: module.label, icon: excelIconMap[module.id] || GitBranch }))} onNavigate={onNavigate} />
              )}
              {studyContext.domain === 'lsat' && <LsatSidebarSection mode={lsatMode} onNavigate={onNavigate} />}

              <div className="sidebar-section-label">Specialized</div>
              <div className="sidebar-section sidebar-utility-links">
                {sidebarToolRoutes.map((route) => {
                  const Icon = routeIconMap[route.iconKey] || Gauge;
                  const path = route.id === 'mock' ? `/cfa/${studyContext.cfaLevel}/mock` : route.path;
                  return (
                    <NavLink key={route.id} to={path} onClick={onNavigate} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                      <Icon />
                      <span>{route.navLabel}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          </details>
        )}
      </nav>
    </aside>
  );
}
