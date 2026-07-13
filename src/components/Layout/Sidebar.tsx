import { useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type SVGProps } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Home, BookOpen, TrendingUp, Table2,
  Calculator, Library, ChevronDown, ChevronRight,
  PanelLeftClose, PanelLeft,
  GraduationCap, BarChart3, Shield, DollarSign,
  LineChart, Building2, Gem, PieChart, Layers,
  Binary, Sigma, Flame, GitBranch, Target, Cpu, BrainCircuit,
  FileSpreadsheet, Code, Gauge,
  Inbox, NotebookTabs, BadgeCheck, ClipboardList, FileSearch, HardDrive, Sun, Network,
  Scale, BookMarked, Clock, Database, Download, Flag, ListMusic, RotateCcw, Settings, ShieldCheck,
} from 'lucide-react';
import { cfaTopics, excelModules, quantModules } from '../../data/catalog';
import { appRoutes } from '../../routes/routeManifest';
import type { AppRoute } from '../../routes/routeManifest';
import { buildLsatNavGroups, type LsatNavMode } from '../../lib/lsatNavSection';

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

const sidebarToolRouteIds = ['today', 'review', 'flashcards', 'vault', 'mock', 'analytics', 'knowledge-graph', 'calculators', 'formulas', 'content-ops', 'system', 'preferences'];
const sidebarToolRoutes: AppRoute[] = appRoutes
  .filter((route) => sidebarToolRouteIds.includes(route.id))
  .sort((a, b) => sidebarToolRouteIds.indexOf(a.id) - sidebarToolRouteIds.indexOf(b.id));

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

export default function Sidebar({
  collapsed,
  open,
  mobileHidden = false,
  onToggle,
  onNavigate,
  onClose,
  lsatMode = 'study',
}: SidebarProps) {
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
      <div className="sidebar-header">
        <div className="sidebar-logo">S</div>
        {!collapsed && <span className="sidebar-title">StudyVault</span>}
        <button
          className="btn-icon btn-ghost"
          onClick={onToggle}
          style={{ marginLeft: 'auto' }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary navigation">
        <div className="sidebar-section">
          <NavLink to="/" end onClick={onNavigate} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <Home />
            {!collapsed && <span>Dashboard</span>}
          </NavLink>
        </div>

        {!collapsed && <div className="sidebar-section-label">Domains</div>}

        <SidebarSection
          label="CFA Program"
          icon={GraduationCap}
          basePath="/cfa"
          items={cfaTopics.map((t) => ({ id: `level1/${t.id}`, label: t.label, icon: cfaIconMap[t.id] || BookOpen }))}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        <SidebarSection
          label="Quant Finance"
          icon={BrainCircuit}
          basePath="/quant"
          items={quantModules.map((module) => ({ id: module.id, label: module.label, icon: quantIconMap[module.id] || Cpu }))}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        <SidebarSection
          label="Excel Training"
          icon={Table2}
          basePath="/excel"
          items={excelModules.map((module) => ({ id: module.id, label: module.label, icon: excelIconMap[module.id] || GitBranch }))}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        {!collapsed && <div className="sidebar-section-label">Tools</div>}

        <div className="sidebar-section">
          {sidebarToolRoutes.map((route) => {
            const Icon = routeIconMap[route.iconKey] || Gauge;
            return (
              <NavLink key={route.id} to={route.path} onClick={onNavigate} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <Icon />
                {!collapsed && <span>{route.navLabel}</span>}
              </NavLink>
            );
          })}
        </div>

        {/* K4: the unified shell's 4th nav section — the merged LSAT surface.
            Always rendered (the unified shell is the only shell as of the K4-13
            cutover). */}
        {!collapsed && <div className="sidebar-section-label">LSAT Lab</div>}
        <LsatSidebarSection collapsed={collapsed} mode={lsatMode} onNavigate={onNavigate} />
      </nav>
    </aside>
  );
}
