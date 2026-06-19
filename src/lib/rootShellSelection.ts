/*
 * K4-7 — the single root-shell selection predicate.
 *
 * src/main.jsx asks this ONCE, pre-paint, to decide which root to mount:
 *   - 'legacy'  → the existing split-shell `StudyVaultRoot` (HostApp <-> LsatRoot
 *                 swap, each with its own BrowserRouter). DEFAULT.
 *   - 'unified' → the K4-7 `<UnifiedRoot>` (one host BrowserRouter routes both
 *                 planes; the LSAT plane mounts via <LsatUnifiedMount>).
 *
 * Extracted to a pure function so the flag-gated root selection is unit-testable
 * without executing main.jsx's `createRoot().render()` side effect. Resolution is
 * synchronous (featureFlags resolves at module load), so a read here never
 * flashes the wrong root.
 */
import { isFeatureEnabled } from './featureFlags';

export type RootShell = 'legacy' | 'unified';

/** Which root shell to mount. 'legacy' unless `LSAT_UNIFIED_SHELL` is ON. */
export function selectRootShell(): RootShell {
  return isFeatureEnabled('LSAT_UNIFIED_SHELL') ? 'unified' : 'legacy';
}
