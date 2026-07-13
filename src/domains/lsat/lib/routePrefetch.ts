import { routePrefetchImporters } from "./routeManifest";

// Perceived-speed: warm a code-split page chunk *before* navigation. The nav
// fires this on hover/focus, so by the time a link is clicked the lazy route's
// chunk is usually already fetched + parsed and the transition is instant.
//
// These dynamic imports use the same specifiers as App.tsx's
// `lazy(() => import("@lsat/pages/X"))` route definitions; Vite dedupes dynamic
// imports by specifier, so prefetching warms the exact chunk the route loads
// (no duplicate chunk). Unknown paths no-op — Dashboard ("/") is eager and not
// every link is code-split, so calling this on any nav target is safe.
const warmed = new Set<string>();

/**
 * Warm the route chunk for `path` once. Idempotent and safe to call on every
 * hover/focus; a failed prefetch clears its mark so a later real navigation can
 * retry. Paths with no code-split chunk simply no-op.
 */
export function prefetchRoute(path: string): void {
  const importer = routePrefetchImporters[path];
  if (!importer || warmed.has(path)) return;
  warmed.add(path);
  void importer().catch(() => {
    warmed.delete(path);
  });
}
