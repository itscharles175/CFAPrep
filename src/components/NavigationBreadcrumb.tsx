import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { crumbsForPath, type Crumb } from '../lib/navigationCrumbs';
import { domainForPath, navigateDomain } from '../lib/domainNav';

/*
 * UX-4 — unified breadcrumb trail for the shared shell chrome.
 *
 * Renders the "where am I" trail for the active location, sourced from
 * `crumbsForPath` (host manifest breadcrumbs OR an LSAT PARENTS trail). It's
 * accessible by construction: a <nav aria-label="Breadcrumb"> wrapping an
 * ordered list, with the final crumb carrying aria-current="page".
 *
 * It mounts in the HOST shell (TopBar). The LSAT shell keeps its own
 * `RouteBreadcrumb` primitive for its Tailwind look; this host component styles
 * with the host's shared design tokens (the `.breadcrumb-*` classes in
 * index.css), so it stays theme-safe across light/dark.
 *
 * Crumb links are domain-aware: a crumb that points into the OTHER plane (only
 * possible from the host shell when, say, a future host page nests under LSAT)
 * soft-hops via navigateDomain; in-plane crumbs use the host router's <Link>.
 */

function CrumbLink({
  crumb,
  currentDomain,
}: {
  crumb: Crumb;
  currentDomain: ReturnType<typeof domainForPath>;
}) {
  const to = crumb.to as string;
  const crossDomain = domainForPath(to) !== currentDomain;
  if (crossDomain) {
    return (
      <button type="button" className="breadcrumb-link" onClick={() => navigateDomain(to)}>
        {crumb.label}
      </button>
    );
  }
  return (
    <Link className="breadcrumb-link" to={to}>
      {crumb.label}
    </Link>
  );
}

export default function NavigationBreadcrumb({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const crumbs = crumbsForPath(pathname);
  const currentDomain = domainForPath(pathname);

  // A single label-only crumb means we're at a plane's root — render nothing,
  // matching the LSAT shell's "nothing on root" behavior.
  if (crumbs.length <= 1) return null;

  return (
    <nav aria-label="Breadcrumb" className={`breadcrumb ${className ?? ''}`.trim()}>
      <ol className="breadcrumb-list">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              <li className="breadcrumb-item">
                {last || !crumb.to ? (
                  <span className="breadcrumb-current" aria-current="page" title={crumb.label}>
                    <span className="breadcrumb-current-label">{crumb.label}</span>
                  </span>
                ) : (
                  <CrumbLink crumb={crumb} currentDomain={currentDomain} />
                )}
              </li>
              {!last && (
                <li className="breadcrumb-separator" role="presentation" aria-hidden="true">
                  <ChevronRight size={14} />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
