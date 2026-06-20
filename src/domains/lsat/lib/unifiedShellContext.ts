/*
 * K4-13a — unified-shell signal for the vendored LSAT surface (Keystone K4
 * Phase 3 prep: "doubled chrome" resolution).
 *
 * THE PROBLEM this solves: when `LSAT_UNIFIED_SHELL` is ON, <LsatUnifiedMount>
 * wraps the LSAT App in the HOST <SharedLayout> (host Sidebar + TopBar +
 * titlebar). But the LSAT App ALSO renders its OWN outer chrome (the AppShell's
 * Sidebar/header + the GlobalChrome Titlebar) — two nav surfaces stacked.
 *
 * THE MECHANISM: a tiny React context carrying `{ unified: boolean }`.
 *   - DEFAULT is `{ unified: false }`, so anything that consumes it WITHOUT a
 *     provider (the LEGACY LsatRoot path, every existing LSAT unit test, the
 *     legacy host shell) behaves byte-for-byte as today — the LSAT App renders
 *     its FULL chrome.
 *   - <LsatUnifiedMount> (flag-ON only) provides `{ unified: true }` around the
 *     mounted LSAT App. Its AppShell then renders CHROMELESS (just the scrollable
 *     content region), letting SharedLayout supply the one sidebar/topbar, and
 *     GlobalChrome drops its Titlebar.
 *
 * Host-importable on purpose: <LsatUnifiedMount> lives in /src (host space) and
 * imports this to supply the provider; the LSAT App/AppShell (in /src/domains/
 * lsat) imports it to consume. Keep this module dependency-light (React only) so
 * both worlds can pull it in without dragging in shell code.
 */

import { createContext, useContext } from 'react';

export interface UnifiedShellValue {
  /** True only when the LSAT App is mounted INSIDE the host <SharedLayout> (the
   *  flag-ON unified shell). False everywhere else — legacy LsatRoot, tests, and
   *  any consumer without a provider — so the default path is unchanged. */
  unified: boolean;
}

/** Default = NOT unified. A consumer with no provider gets the legacy behavior
 *  (the LSAT App renders its full AppShell + Titlebar), so flag-OFF is intact. */
export const UnifiedShellContext = createContext<UnifiedShellValue>({
  unified: false,
});

/** Convenience hook: `true` only under the unified host shell. */
export function useUnifiedShell(): boolean {
  return useContext(UnifiedShellContext).unified;
}
