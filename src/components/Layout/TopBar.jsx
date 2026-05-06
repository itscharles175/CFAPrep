import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Menu, Moon, RefreshCw, Search, Sun, WifiOff, X } from 'lucide-react';
import { buildSearchItems } from '../../data/catalog';
import { level3TopicBelongsToPathway } from '../../domains/cfa/cfaLevel3Pathways';
import { useLevel3Pathway } from '../../domains/cfa/useLevel3Pathway';
import { useTheme } from '../../context/ThemeContext';
import { useProgressSummary } from '../../hooks/useProgress';
import { exportVaultData, repairVaultData } from '../../lib/learning';
import { searchCfaSourceVault } from '../../lib/cfaSourceVault';
import { commandRoutes } from '../../routes/routeManifest';

function normalizeSearch(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreSearchItem(item, terms) {
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

function commandResultDomId(id) {
  return `command-result-${String(id).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function TopBar({ collapsed, navOpen = false, onMenuToggle }) {
  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();
  const summary = useProgressSummary();
  const [activePathway] = useLevel3Pathway();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [cacheVersion, setCacheVersion] = useState(null);
  const [applyUpdate, setApplyUpdate] = useState(null);
  const [commandMessage, setCommandMessage] = useState('');
  const [sourceResults, setSourceResults] = useState([]);
  const inputRef = useRef(null);
  const searchRef = useRef(null);
  const searchItems = useMemo(() => buildSearchItems({ level3Pathway: activePathway }), [activePathway]);
  const commandItems = useMemo(
    () => [
      ...searchItems,
      ...commandRoutes.map((item) => ({
        ...item,
        type: item.action ? 'action' : 'command',
      })),
    ],
    [searchItems],
  );

  const results = useMemo(() => {
    const normalized = normalizeSearch(query);
    if (!normalized) return commandItems.slice(0, 8);
    const terms = normalized.split(' ');
    const routeResults = commandItems
      .map((item) => ({ item, score: scoreSearchItem(item, terms) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.item)
      .slice(0, 6);
    return [...sourceResults, ...routeResults].slice(0, 8);
  }, [commandItems, query, sourceResults]);

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

  useEffect(() => {
    function handlePointerDown(event) {
      if (!searchRef.current?.contains(event.target)) setSearchOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
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

    function handlePwaVersion(event) {
      setCacheVersion(event.detail);
    }

    function handlePwaUpdate(event) {
      setApplyUpdate(() => event.detail.applyUpdate);
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

  async function goToResult(item) {
    if (item.disabled) return;
    if (item.action === 'backup') {
      downloadJson(await exportVaultData());
      setCommandMessage('Vault backup exported.');
    } else if (item.action === 'repair') {
      const preview = await repairVaultData();
      const rows = Object.values(preview.counts).reduce((sum, count) => sum + count, 0);
      setCommandMessage(`Vault repair complete. ${rows} rows checked.`);
    } else if (item.action === 'theme') {
      toggleTheme();
      setCommandMessage('Theme toggled.');
    } else {
      navigate(item.path);
    }
    setQuery('');
    setSearchOpen(false);
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
          aria-activedescendant={searchOpen && results[selectedIndex] ? commandResultDomId(results[selectedIndex].id) : undefined}
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
              setSelectedIndex((value) => Math.min(results.length - 1, value + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === 'Enter' && results[selectedIndex]) goToResult(results[selectedIndex]);
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
              results.map((item, index) => (
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
                </div>
              ))
            ) : (
              <div className="search-empty">No matching modules or formulas.</div>
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
        <button className="btn-icon btn-ghost" title="Toggle theme" onClick={toggleTheme}>
          {isDark ? <Moon size={18} /> : <Sun size={18} />}
        </button>
      </div>

      {notificationsOpen && (
        <div className="notifications-popover">
          <div className="notifications-title">Study Signals</div>
          {summary.upcomingReviews.length ? (
            summary.upcomingReviews.map((item) => (
              <Link key={item.id} to={item.path} className="notification-item" onClick={() => setNotificationsOpen(false)}>
                <span>{item.title}</span>
                <small>Due {new Date(item.dueAt).toLocaleDateString()} - {item.lastConfidence} confidence</small>
              </Link>
            ))
          ) : (
            <div className="notification-empty">
              {summary.questionsAnswered ? 'No weak areas flagged from recent attempts.' : 'Take a quiz to unlock review signals.'}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
