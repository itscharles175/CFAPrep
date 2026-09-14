import { useLocation } from 'react-router-dom';

/*
 * UX-4 — domain badge for the shared shell chrome.
 *
 * A small status pill naming the active study plane (CFA / Quant / Excel / LSAT
 * / Vault / StudyVault), so the user always knows which app the unified window
 * is showing — especially after a cross-domain soft-hop, where the URL is the
 * only other cue.
 *
 * The plane is derived purely from the URL (the single source of truth the two
 * routers agree on). Styling reuses the host's existing `.search-result-domain`
 * token classes (per-domain accent colors that are already theme-safe), so the
 * badge matches the command-palette domain chips exactly. It's a `role="status"`
 * with a descriptive aria-label so screen readers announce the active plane.
 */

type Plane = 'cfa' | 'lsat' | 'quant' | 'excel' | 'vault' | 'general';

const PLANE_LABEL: Record<Plane, string> = {
  cfa: 'CFA',
  lsat: 'LSAT',
  quant: 'Quant',
  excel: 'Excel',
  vault: 'Vault',
  general: 'StudyVault',
};

const PLANE_DESCRIPTION: Record<Plane, string> = {
  cfa: 'CFA Program',
  lsat: 'LSAT study workspace',
  quant: 'Quant Finance',
  excel: 'Excel Training',
  vault: 'Vault',
  general: 'StudyVault',
};

function planeForPath(pathname: string): Plane {
  if (pathname === '/lsat' || pathname.startsWith('/lsat/')) return 'lsat';
  if (pathname === '/cfa' || pathname.startsWith('/cfa/')) return 'cfa';
  if (pathname === '/quant' || pathname.startsWith('/quant/')) return 'quant';
  if (pathname === '/excel' || pathname.startsWith('/excel/')) return 'excel';
  if (pathname === '/vault' || pathname.startsWith('/vault')) return 'vault';
  return 'general';
}

export default function DomainIndicator({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const plane = planeForPath(pathname);
  return (
    <span
      role="status"
      aria-label={`Active domain: ${PLANE_DESCRIPTION[plane]}`}
      className={`domain-indicator search-result-domain search-result-domain-${plane} ${className ?? ''}`.trim()}
    >
      {PLANE_LABEL[plane]}
    </span>
  );
}
