/*
 * UX-4 — LSAT-side adapter onto the shared cross-domain navigation history.
 *
 * The shared store (`@/lib/navigationHistory`) records full app paths
 * (`/lsat/srs`, `/cfa/...`). But the LSAT app runs under
 * `<BrowserRouter basename="/lsat">`, so inside the LSAT tree `useLocation()`
 * yields app-relative paths (`/srs`, `/`). This adapter bridges that gap: it
 * prefixes the basename and resolves the friendly label from the LSAT manifest
 * before delegating to the shared `pushHistory`, so LSAT in-plane navigations
 * land on the same trail the host shell reads.
 *
 * Used by the LSAT AppShell to record each route change.
 */

import { pushHistory } from "@/lib/navigationHistory";
import { routeCommandLabel } from "@lsat/lib/commandRecents";

const LSAT_PREFIX = "/lsat";

/** Full host-served path for an app-relative LSAT path. */
export function toHostPath(appRelative: string): string {
  if (appRelative === "/" || appRelative === "") return LSAT_PREFIX;
  return `${LSAT_PREFIX}${appRelative}`;
}

/**
 * Record an LSAT in-plane navigation on the shared trail. `appRelative` is the
 * LSAT router's own pathname (no `/lsat` prefix); the label comes from the same
 * map that titles the LSAT breadcrumb + command-palette recents.
 */
export function recordLsatVisit(appRelative: string): void {
  pushHistory({
    path: toHostPath(appRelative),
    domain: "lsat",
    label: routeCommandLabel(appRelative),
  });
}
