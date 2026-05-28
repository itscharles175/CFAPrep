import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Home, BookOpen, TrendingUp, Table2,
  Calculator, Library, ChevronDown, ChevronRight,
  PanelLeftClose, PanelLeft,
  GraduationCap, BarChart3, Shield, DollarSign,
  LineChart, Building2, Gem, PieChart, Layers,
  Binary, Sigma, Flame, GitBranch, Target, Cpu, BrainCircuit,
  FileSpreadsheet, Code, Gauge,
  Inbox, NotebookTabs, BadgeCheck, ClipboardList, FileSearch, HardDrive, Sun,
} from 'lucide-react';
import { cfaTopics, excelModules, quantModules } from '../../data/catalog';
import { appRoutes } from '../../routes/routeManifest';

const cfaIconMap = {
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

const quantIconMap = {
  probability: Binary,
  'linear-algebra': Layers,
  'stochastic-calc': Flame,
  'derivatives-pricing': LineChart,
  'risk-management': Target,
  'portfolio-optimization': PieChart,
};

const excelIconMap = {
  fundamentals: Table2,
  'advanced-formulas': Sigma,
  'financial-functions': DollarSign,
  'dcf-modeling': TrendingUp,
  'vba-macros': Code,
};

const routeIconMap = {
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
};

const sidebarToolRouteIds = ['today', 'review', 'flashcards', 'vault', 'mock', 'analytics', 'calculators', 'formulas', 'content-ops', 'system'];
const sidebarToolRoutes = appRoutes
  .filter((route) => sidebarToolRouteIds.includes(route.id))
  .sort((a, b) => sidebarToolRouteIds.indexOf(a.id) - sidebarToolRouteIds.indexOf(b.id));

function SidebarSection({ label, icon: Icon, basePath, items, collapsed, onNavigate }) {
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
          {items.map(item => (
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

export default function Sidebar({ collapsed, open, mobileHidden = false, onToggle, onNavigate }) {
  return (
    <aside
      id="main-sidebar"
      className={`sidebar ${collapsed ? 'collapsed' : ''} ${open ? 'open' : ''}`}
      role="complementary"
      aria-label="Main navigation sidebar"
      hidden={mobileHidden}
      inert={mobileHidden ? '' : undefined}
    >
      <div className="sidebar-header">
        <div className="sidebar-logo">Q</div>
        {!collapsed && <span className="sidebar-title">QuantVault</span>}
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
          items={cfaTopics.map(t => ({ ...t, id: `level1/${t.id}`, icon: cfaIconMap[t.id] || BookOpen }))}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        <SidebarSection
          label="Quant Finance"
          icon={BrainCircuit}
          basePath="/quant"
          items={quantModules.map(module => ({ ...module, icon: quantIconMap[module.id] || Cpu }))}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        <SidebarSection
          label="Excel Training"
          icon={Table2}
          basePath="/excel"
          items={excelModules.map(module => ({ ...module, icon: excelIconMap[module.id] || GitBranch }))}
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
      </nav>
    </aside>
  );
}
