import { Fragment, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { routeCommandLabel } from "@/lib/commandRecents";

/**
 * R9 (docs/19 F5) — router-driven breadcrumb. Wakes the dormant `ui/breadcrumb`
 * primitive and feeds it the current route, so the unified desktop frame can
 * show *where you are* (Section history nests under Review; a type/PT drill-down
 * nests under Analytics) instead of two empty stacked bars.
 *
 * Labels reuse the same `routeCommandLabel` map that titles command-palette
 * "Recent" entries, so a route is named identically wherever it surfaces. The
 * trail is derived purely from `pathname`; on the root ("/") nothing renders.
 */

/** A parent route to nest a deeper screen under, with a friendly trail label. */
const PARENTS: { match: (p: string) => boolean; to: string; label: string }[] = [
  { match: (p) => p.startsWith("/review/history"), to: "/review", label: "Review" },
  { match: (p) => p.startsWith("/analytics/"), to: "/analytics", label: "Analytics" },
  { match: (p) => p.startsWith("/bank/"), to: "/bank", label: "Bank" },
];

interface Crumb {
  label: string;
  to?: string;
}

function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/" || pathname === "") return [];
  const parent = PARENTS.find((p) => p.match(pathname));
  const current: Crumb = { label: routeCommandLabel(pathname) };
  const trail: Crumb[] = [{ label: "Dashboard", to: "/" }];
  if (parent && parent.to !== pathname) {
    trail.push({ label: parent.label, to: parent.to });
  }
  trail.push(current);
  return trail;
}

export function RouteBreadcrumb({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const crumbs = useMemo(() => crumbsFor(pathname), [pathname]);
  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              <BreadcrumbItem>
                {last || !c.to ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
