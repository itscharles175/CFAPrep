import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, HelpCircle, Menu, Monitor, Moon, RefreshCw, Search, Sun, WifiOff, X } from 'lucide-react';
import { buildSearchItems } from '../../data/catalog';
import { navigateDomain } from '../../lib/domainNav';
import { level3TopicBelongsToPathway } from '../../domains/cfa/cfaLevel3Pathways';
import { useLevel3Pathway } from '../../domains/cfa/useLevel3Pathway';
import { useTheme } from '../../context/ThemeContext';
import { useProgressSummary } from '../../hooks/useProgress';
import { exportVaultData, repairVaultData } from '../../lib/learning';
import { searchCfaSourceVault } from '../../lib/cfaSourceVault';
import { searchAllContent, type ContentHit } from '../../lib/contentSearch';
import { commandRoutes } from '../../routes/routeManifest';
import { KEYBOARD_HELP_EVENT } from '../KeyboardHelp/KeyboardHelp';
import { NotificationCenter } from './NotificationCenter';
import NavigationBreadcrumb from '../NavigationBreadcrumb';
import DomainIndicator from '../DomainIndicator';
import NavBackButton from '../NavBackButton';
import { pushHistory } from '../../lib/navigationHistory';
import { labelForPath } from '../../lib/navigationCrumbs';

// Unified shape used to render the command-palette results. Both
// `buildSearchItems` and `commandRoutes` items conform to this, and
// `sourceResults` are produced locally inside this component.
interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string;
  type: string;
  path: string;
  keywords: string[];
  disabled?: boolean;
  action?: 'backup' | 'repair' | 'theme';
  /** S4: route lives in another domain (LSAT) → soft-navigate cross-domain. */
  external?: boolean;
}

// UB6 — palette domain scope. Every result is attributed to one domain so the
// row can carry a badge (CFA / LSAT / Quant / Excel / …) and so results from the
// currently active domain can be ranked above the rest. `general` covers
// cross-cutting tools, commands, and vault items that don't belong to a single
// study domain.
type PaletteDomain = 'cfa' | 'lsat' | 'quant' | 'excel' | 'vault' | 'general';

const domainBadgeLabel: Record<PaletteDomain, string> = {
  cfa: 'CFA',
  lsat: 'LSAT',
  quant: 'Quant',
  excel: 'Excel',
  vault: 'Vault',
  general: 'App',
};

// Resolve the study domain a search result belongs to from its path (the most
// reliable signal — ids and types vary across catalog/command sources).
function domainForResult(item: SearchResultItem): PaletteDomain {
  const path = item.path || '';
  if (item.external || path === '/lsat' || path.startsWith('/lsat/')) return 'lsat';
  if (path === '/cfa' || path.startsWith('/cfa/')) return 'cfa';
  if (path === '/quant' || path.startsWith('/quant/')) return 'quant';
  if (path === '/excel' || path.startsWith('/excel/')) return 'excel';
  if (path === '/vault' || path.startsWith('/vault')) return 'vault';
  return 'general';
}

// Which study domain the user is currently in, from the active URL — used to
// float that domain's results to the top of the palette.
function activeDomainForPath(pathname: string): PaletteDomain {
  if (pathname === '/lsat' || pathname.startsWith('/lsat/')) return 'lsat';
  if (pathname === '/cfa' || pathname.startsWith('/cfa/')) return 'cfa';
  if (pathname === '/quant' || pathname.startsWith('/quant/')) return 'quant';
  if (pathname === '/excel' || pathname.startsWith('/excel/')) return 'excel';
  if (pathname === '/vault' || pathname.startsWith('/vault')) return 'vault';
  return 'general';
}

// UB6 — "jump to domain" quick hops. Each entry is a full-fat SearchResultItem
// so it routes through the same goToResult() path (LSAT carries `external` so it
// soft-navigates cross-domain via navigateDomain).
const domainJumps: SearchResultItem[] = [
  { id: 'jump:cfa', title: 'CFA Program', subtitle: 'Jump to the CFA dashboard', type: 'Jump', path: '/cfa', keywords: ['cfa', 'jump', 'domain'] },
  { id: 'jump:quant', title: 'Quant Finance', subtitle: 'Jump to the Quant dashboard', type: 'Jump', path: '/quant', keywords: ['quant', 'jump', 'domain'] },
  { id: 'jump:excel', title: 'Excel Training', subtitle: 'Jump to the Excel dashboard', type: 'Jump', path: '/excel', keywords: ['excel', 'jump', 'domain'] },
  { id: 'jump:lsat', title: 'LSAT Lab', subtitle: 'Jump to the LSAT domain', type: 'Jump', path: '/lsat', keywords: ['lsat', 'jump', 'domain'], external: true },
];

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreSearchItem(item: SearchResultItem, terms: string[]): number {
  const title = normalizeSearch(item.title);
  const subtitle = normalizeSearch(item.subtitle || '');
  const keywords = normalizeSearch(item.keywords.join(' '));
  return terms.reduce((score, term) => {
    if (title.startsWith(term)) return score + 8;
    if (title.includes(term)) return score + 5;
    if (keywords.includes(term)) return score + 3;
    if (subtitle.includes(term)) return score + 1;
    return score - 100;
  }, 0);
}

function commandResultDomId(id: string): string {
  return `command-result-${String(id).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

// UX-2 — project a unified content hit onto the palette's shared
// SearchResultItem shape so it renders through the same row + badge + keyboard
// path as routes/sources. `external` carries through so LSAT question hits
// soft-navigate cross-domain (navigateDomain) instead of using the host router.
function contentHitToResult(hit: ContentHit): SearchResultItem {
  const typeLabel =
    hit.source === 'lsat-question' ? 'Question' : hit.source === 'notebook' ? 'Notebook' : 'Content';
  return {
    id: hit.id,
    title: hit.title,
    subtitle: hit.subtitle,
    type: typeLabel,
    path: hit.deepLink,
    keywords: [],
    external: hit.external,
  };
}

function downloadJson(payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface TopBarProps {
  collapsed?: boolean;
  navOpen?: boolean;
  onMenuToggle?: () => void;
}

export default function TopBar({ collapsed, navOpen = false, onMenuToggle }: TopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const activeDomain = activeDomainForPath(location.pathname);
  const { theme, cycleTheme } = useTheme();
  const summary = useProgressSummary();
  const [activePathway] = useLevel3Pathway() as [string, (next: string) => void];
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [offline, setOffline] = useState<boolean>(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [cacheVersion, setCacheVersion] = useState<string | null>(null);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  const [commandMessage, setCommandMessage] = useState('');
  const [sourceResults, setSourceResults] = useState<SearchResultItem[]>([]);
  // UX-2 — unified content hits (host curriculum + LSAT questions + notebook
  // sources), unioned + active-domain-weighted by `searchAllContent`. Mapped onto
  // the shared SearchResultItem shape so they flow through the same row renderer,
  // keyboard cursor, and goToResult() (LSAT hits carry `external` → soft-nav).
  const [contentResults, setContentResults] = useState<SearchResultItem[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const searchItems = useMemo(() => buildSearchItems({ level3Pathway: activePathway }), [activePathway]);
  const commandItems = useMemo<SearchResultItem[]>(
    () => [
      ...searchItems,
      ...commandRoutes.map((item) => ({
        ...item,
        type: item.action ? 'action' : 'command',
      })),
    ],
    [searchItems],
  );

  const results = useMemo<SearchResultItem[]>(() => {
    const normalized = normalizeSearch(query);
    if (!normalized) {
      // UB6: default list floats the active domain's items to the top so the
      // palette opens with the most relevant context first (stable order within
      // each domain tier preserves the catalog ordering).
      if (activeDomain === 'general') return commandItems.slice(0, 8);
      const inDomain = commandItems.filter((item) => domainForResult(item) === activeDomain);
      const others = commandItems.filter((item) => domainForResult(item) !== activeDomain);
      return [...inDomain, ...others].slice(0, 8);
    }
    const terms = normalized.split(' ');
    const routeResults = commandItems
      .map((item) => ({ item, score: scoreSearchItem(item, terms) }))
      .filter((row) => row.score >= 0)
      // UB6: current-domain priority — equal-relevance results from the active
      // domain rank above other domains. The bump is small enough that a strong
      // textual match from another domain still wins.
      .sort((a, b) => {
        const domainBump =
          (domainForResult(b.item) === activeDomain ? 2 : 0) -
          (domainForResult(a.item) === activeDomain ? 2 : 0);
        return b.score - a.score + domainBump;
      })
      .map((row) => row.item)
      .slice(0, 6);
    // UX-2: surface CONTENT hits (curriculum / LSAT questions / notebook sources)
    // alongside the private source matches and route results — content is already
    // active-domain-weighted by searchAllContent, so it leads the route rows.
    return [...sourceResults, ...contentResults, ...routeResults].slice(0, 8);
  }, [commandItems, query, sourceResults, contentResults, activeDomain]);

  // UB6: "jump to domain" quick hops — always exclude the domain the user is
  // already in so the section only offers cross-domain moves.
  const domainJumpRows = useMemo<SearchResultItem[]>(
    () => domainJumps.filter((jump) => domainForResult(jump) !== activeDomain),
    [activeDomain],
  );

  // The keyboard cursor (ArrowUp/Down + Enter + aria-activedescendant) spans
  // both the result rows and the jump-to-domain rows as one flat list, so the
  // two visual sections feel like a single navigable palette.
  const navigableResults = useMemo<SearchResultItem[]>(
    () => [...results, ...domainJumpRows],
    [results, domainJumpRows],
  );

  useEffect(() => {
    let active = true;
    const normalized = normalizeSearch(query);
    if (normalized.length < 3) {
      Promise.resolve().then(() => {
        if (active) setSourceResults([]);
      });
      return () => {
        active = false;
      };
    }
    searchCfaSourceVault(query, 6).then((matches) => {
      if (!active) return;
      setSourceResults(
        matches
          .filter((match) => {
            if (match.document.level !== 'level3') return true;
            const topicIds = match.chunk.topicIds?.length ? match.chunk.topicIds : match.document.topicIds;
            return topicIds.some((topicId) => level3TopicBelongsToPathway(topicId, activePathway));
          })
          .slice(0, 3)
          .map((match) => ({
            id: `source:${match.chunk.id}`,
            title: match.document.title,
            subtitle: `${match.document.publisher} · ${match.document.level?.replace('level', 'Level ')} · ${match.chunk.locator} · private source match`,
            type: 'Source',
            path: `/vault?sourceQuery=${encodeURIComponent(query)}&chunk=${encodeURIComponent(match.chunk.id)}`,
            keywords: [match.document.title, match.document.publisher, match.document.level],
          })),
      );
    });
    return () => {
      active = false;
    };
  }, [activePathway, query]);

  // UX-2 — unified content search. Same debounce gate (>=3 chars) + active-flag
  // teardown as the source-vault effect above. `searchAllContent` unions host
  // curriculum chunks, LSAT questions, and open-notebook sources, weighting the
  // active domain (derived from the URL). Fully degrading: any source failing
  // contributes no rows, so the union resolves to whatever is reachable.
  useEffect(() => {
    let active = true;
    const normalized = normalizeSearch(query);
    if (normalized.length < 3) {
      Promise.resolve().then(() => {
        if (active) setContentResults([]);
      });
      return () => {
        active = false;
      };
    }
    const controller = new AbortController();
    searchAllContent({ query, pathname: location.pathname, limit: 5, signal: controller.signal })
      .then((hits) => {
        if (!active) return;
        setContentResults(hits.map(contentHitToResult));
      })
      .catch(() => {
        if (active) setContentResults([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [location.pathname, query]);

  // UX-4 — record every host route change on the shared cross-domain trail so
  // the unified Back button + breadcrumb stay accurate. `pushHistory` de-dupes a
  // repeat of the current path, so this is safe alongside the cross-domain
  // recording in navigateDomain and the popstate seed in main.jsx.
  useEffect(() => {
    pushHistory({ path: location.pathname, domain: 'host', label: labelForPath(location.pathname) });
  }, [location.pathname]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setNotificationsOpen(false);
        inputRef.current?.blur();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    function handleOnline() {
      setOffline(false);
    }

    function handleOffline() {
      setOffline(true);
    }

    function handlePwaVersion(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      setCacheVersion(detail);
    }

    function handlePwaUpdate(event: Event) {
      const detail = (event as CustomEvent<{ applyUpdate: () => void }>).detail;
      setApplyUpdate(() => detail.applyUpdate);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('quantvault:pwa-version', handlePwaVersion);
    window.addEventListener('quantvault:pwa-update', handlePwaUpdate);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('quantvault:pwa-version', handlePwaVersion);
      window.removeEventListener('quantvault:pwa-update', handlePwaUpdate);
    };
  }, []);

  async function goToResult(item: SearchResultItem) {
    if (item.disabled) return;
    if (item.action === 'backup') {
      downloadJson(await exportVaultData());
      setCommandMessage('Vault backup exported.');
    } else if (item.action === 'repair') {
      const preview = await repairVaultData();
      const rows = Object.values(preview.counts).reduce((sum, count) => sum + count, 0);
      setCommandMessage(`Vault repair complete. ${rows} rows checked.`);
    } else if (item.action === 'theme') {
      cycleTheme();
      setCommandMessage('Theme cycled.');
    } else if (item.external) {
      // S4: cross-domain jump (e.g. into LSAT) — soft-swap via the unified root,
      // not the host client router (which has no /lsat route).
      navigateDomain(item.path);
    } else {
      navigate(item.path);
    }
    setQuery('');
    setSearchOpen(false);
  }

  // UB6: one result row, used by both the main result list and the
  // jump-to-domain section. `index` is the row's position in navigableResults so
  // the keyboard cursor and aria-selected stay in sync across both sections.
  function renderResultRow(item: SearchResultItem, index: number) {
    const domain = domainForResult(item);
    return (
      <div
        key={item.id}
        id={commandResultDomId(item.id)}
        role="option"
        aria-selected={index === selectedIndex}
        aria-disabled={item.disabled || undefined}
        className={`search-result ${index === selectedIndex ? 'active' : ''}`}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => goToResult(item)}
      >
        <span className="search-result-type">{item.type}</span>
        <span>
          <strong>{item.title}</strong>
          <small>{item.disabled ? 'Coming soon' : item.subtitle}</small>
        </span>
        {/* UB6: domain badge so each result shows which domain it belongs to. */}
        <span className={`search-result-domain search-result-domain-${domain}`}>{domainBadgeLabel[domain]}</span>
      </div>
    );
  }

  return (
    <header className={`topbar ${collapsed ? 'collapsed' : ''}`}>
      <button
        className="btn-icon btn-ghost mobile-menu-button"
        title="Open navigation"
        aria-expanded={navOpen}
        aria-controls="main-sidebar"
        onClick={onMenuToggle}
      >
        <Menu size={18} />
      </button>

      {/* UX-4 — shared shell chrome: history-aware Back + unified breadcrumb +
          domain badge. Back delegates same-domain hops to the host router; the
          breadcrumb/badge are derived purely from the URL. */}
      <div className="topbar-nav">
        <NavBackButton onSameDomainBack={() => navigate(-1)} />
        <NavigationBreadcrumb className="topbar-breadcrumb" />
        <DomainIndicator className="topbar-domain" />
      </div>

      <div
        ref={searchRef}
        className="topbar-search"
      >
        <Search />
        <input
          ref={inputRef}
          id="command-palette-input"
          type="text"
          placeholder="Search modules, formulas, topics..."
          aria-label="Command palette"
          role="combobox"
          aria-expanded={searchOpen}
          aria-haspopup="listbox"
          aria-controls={searchOpen ? 'command-palette-results' : undefined}
          aria-activedescendant={searchOpen && navigableResults[selectedIndex] ? commandResultDomId(navigableResults[selectedIndex].id) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((value) => Math.min(navigableResults.length - 1, value + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === 'Enter' && navigableResults[selectedIndex]) goToResult(navigableResults[selectedIndex]);
          }}
        />
        {query ? (
          <button className="btn-icon btn-ghost search-clear" title="Clear search" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        ) : (
          <kbd>Ctrl+K</kbd>
        )}

        {searchOpen && (
          <div id="command-palette-results" className="search-popover" role="listbox" aria-label="Command palette results">
            <div className="search-palette-title">Command Palette</div>
            {results.length ? (
              results.map((item, index) => renderResultRow(item, index))
            ) : (
              <div className="search-empty">No matching modules or formulas.</div>
            )}
            {/* UB6: jump-to-domain section — fast cross-domain hops, keyboard
                cursor continues from the main results into these rows. */}
            {domainJumpRows.length > 0 && (
              <>
                <div className="search-palette-title search-palette-subtitle">Jump to domain</div>
                {domainJumpRows.map((item, index) => renderResultRow(item, results.length + index))}
              </>
            )}
            {commandMessage && <div className="search-empty">{commandMessage}</div>}
          </div>
        )}
      </div>
      <div className="topbar-actions">
        {offline && (
          <span className="badge badge-amber" title="Offline mode">
            <WifiOff size={12} /> Offline
          </span>
        )}
        {cacheVersion && (
          <span className="badge badge-blue" title="Service worker cache version">
            {cacheVersion}
          </span>
        )}
        {applyUpdate && (
          <button
            className="btn btn-secondary"
            style={{ padding: 'var(--space-2) var(--space-3)' }}
            onClick={() => {
              applyUpdate();
              setApplyUpdate(null);
            }}
          >
            <RefreshCw size={14} /> Update
          </button>
        )}
        <button
          className="btn-icon btn-ghost"
          title="Notifications"
          aria-expanded={notificationsOpen}
          onClick={() => setNotificationsOpen((open) => !open)}
        >
          <Bell size={18} />
          {summary.upcomingReviews.length > 0 && <span className="notification-dot" />}
        </button>
        <button
          className="btn-icon btn-ghost"
          title="Keyboard shortcuts (press ?)"
          aria-label="Open keyboard shortcuts help"
          onClick={() => window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT))}
        >
          <HelpCircle size={18} />
        </button>
        <button
          className="btn-icon btn-ghost"
          title={`Theme: ${theme} (click to cycle Light → Dark → System)`}
          aria-label={`Theme: ${theme}. Click to cycle through Light, Dark, and System.`}
          onClick={cycleTheme}
        >
          {theme === 'light' ? (
            <Sun size={18} />
          ) : theme === 'dark' ? (
            <Moon size={18} />
          ) : (
            <Monitor size={18} />
          )}
        </button>
      </div>

      {notificationsOpen && (
        <div className="notifications-popover">
          {/* UX-6: cross-domain notification surface — folds host due reviews +
              the LSAT sidecar's ability-ranked queue into one nudge. Self-wiring
              and fully degrading (a down sidecar quietly omits LSAT rows). */}
          <NotificationCenter onNavigate={() => setNotificationsOpen(false)} />
        </div>
      )}
    </header>
  );
}
