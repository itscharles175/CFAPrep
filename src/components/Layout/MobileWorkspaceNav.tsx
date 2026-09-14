import { Activity, BarChart3, BookOpen, Dumbbell, HardDrive, Library, MoreHorizontal, RefreshCw, Settings, Sun } from 'lucide-react';
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
            aria-current={active ? 'page' : undefined}
            className={active ? 'active' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{workspace.label}</span>
          </NavLink>
        );
      })}
      <details className="mobile-workspace-more">
        <summary className={activeWorkspace === 'progress' || activeWorkspace === 'library' || activeWorkspace === 'utility' ? 'active' : undefined} aria-label="More workspaces and utilities">
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
                onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
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
