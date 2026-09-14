import { Activity, BarChart3, BookOpen, Dumbbell, HardDrive, Library, MoreHorizontal, RefreshCw, Settings, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { workspaceForLocation, type StudyWorkspace } from '../../routes/routeManifest';
import { useStudyContext, workspaceHref } from '../../lib/studyContext';

const workspaces: Array<{
  id: Exclude<StudyWorkspace, 'utility'>;
  label: string;
  icon: typeof Sun;
}> = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'learn', label: 'Learn', icon: BookOpen },
  { id: 'practice', label: 'Practice', icon: Dumbbell },
  { id: 'review', label: 'Review', icon: RefreshCw },
];

const moreItems = [
  { id: 'progress', label: 'Progress', icon: BarChart3 },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'tutor', label: 'Tutor', icon: BookOpen, path: '/library/tutor' },
  { id: 'vault', label: 'Vault', icon: HardDrive, path: '/vault' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/preferences' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity, path: '/system' },
];

export default function MobileWorkspaceNav() {
  const location = useLocation();
  const [studyContext] = useStudyContext();
  const activeWorkspace = workspaceForLocation(location.pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const closeFromOutside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      summaryRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeFromOutside);
    window.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      window.removeEventListener('keydown', closeFromEscape);
    };
  }, [moreOpen]);

  // Active CFA assessments own the compact screen. The route keeps its own
  // explicit Back action, while removing the global bar prevents answers and
  // the primary action from competing with unrelated workspace navigation.
  if (
    /^\/cfa\/level[123]\/[^/]+\/(quiz|vignette|constructed-response)(?:\/|$)/.test(location.pathname)
    || /^\/lsat\/(take|exam|blind-review|popout)(?:\/|$)/.test(location.pathname)
  ) {
    return null;
  }

  return (
    <nav className="mobile-workspace-nav" aria-label="Study workspaces">
      {workspaces.map((workspace) => {
        const Icon = workspace.icon;
        const active = activeWorkspace === workspace.id;
        return (
          <NavLink
            key={workspace.id}
            to={workspaceHref(workspace.id, studyContext)}
            end={workspace.id === 'today'}
            aria-label={workspace.label}
            aria-current={active ? 'page' : undefined}
            className={active ? 'active' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{workspace.label}</span>
          </NavLink>
        );
      })}
      <details ref={moreRef} className="mobile-workspace-more" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
        <summary ref={summaryRef} className={activeWorkspace === 'progress' || activeWorkspace === 'library' || activeWorkspace === 'utility' ? 'active' : undefined} aria-label="More workspaces and utilities">
          <MoreHorizontal aria-hidden="true" />
          <span>More</span>
        </summary>
        <div className="mobile-workspace-more-panel">
          {moreItems.map((item) => {
            const Icon = item.icon;
            const path = item.path ?? workspaceHref(item.id as 'progress' | 'library', studyContext);
            return (
              <NavLink
                key={item.id}
                to={path}
                onClick={() => {
                  setMoreOpen(false);
                  requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
                }}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </details>
    </nav>
  );
}
