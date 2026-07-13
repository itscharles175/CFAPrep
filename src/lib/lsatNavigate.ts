/*
 * K4-5 — LSAT nav wrapper (Phase 1 of Keystone K4: full UI unification).
 *
 * The vendored LSAT pages were authored against their OWN router whose URLs are
 * app-relative ("/", "/srs", "/take/:id"). Under the unified StudyVault shell
 * the same surface is served at "/lsat/*" (see src/lib/domainNav.ts). This
 * module is the single, minimal-churn adapter so an LSAT-internal link or
 * `navigate("/srs")` resolves to "/lsat/srs" when the page later runs under the
 * unified shell.
 *
 *   - `LSAT_ROUTE_PREFIX` — the host basename the LSAT plane lives under.
 *   - `toLsatPath(p)` — pure: prefixes an app-relative LSAT path with /lsat,
 *     idempotent (an already-prefixed or external/non-relative path is left
 *     alone), and preserves query/hash.
 *   - `useLsatNavigate()` — wraps react-router's `useNavigate` so a relative
 *     LSAT path is prefixed before navigating; absolute (host) paths,
 *     deltas (navigate(-1)), and already-/lsat paths pass through untouched.
 *
 * NOT wired into the LSAT pages here — that is the reskin phase (K4 later). This
 * file lives in the HOST tree (src/lib), so it must not import the vendored LSAT
 * subtree; the prefix is a literal, kept in sync with domainNav.ts by the unit
 * test.
 */

import { useCallback } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';

/** The host basename the LSAT plane is served under (mirrors domainNav.ts). */
export const LSAT_ROUTE_PREFIX = '/lsat';

/**
 * Prefix an app-relative LSAT path with `/lsat`. Idempotent and safe on any
 * input:
 *   - `"/"`            -> `"/lsat"`
 *   - `"/srs"`         -> `"/lsat/srs"`
 *   - `"/take/42?x=1"` -> `"/lsat/take/42?x=1"`  (query/hash preserved)
 *   - `"/lsat/srs"`    -> `"/lsat/srs"`           (already prefixed -> unchanged)
 *   - `"foo"`          -> `"foo"`                  (router-relative -> unchanged)
 *   - `"https://…"`    -> unchanged               (external -> unchanged)
 */
export function toLsatPath(path: string): string {
  // Only absolute, in-app paths are rewritten. Router-relative segments
  // ("foo", "../bar") and external/protocol URLs are left to the caller/router.
  if (!path.startsWith('/')) return path;
  if (path === LSAT_ROUTE_PREFIX || path.startsWith(`${LSAT_ROUTE_PREFIX}/`)) {
    return path;
  }
  // `/` is the LSAT plane root: it maps to the bare prefix, not "/lsat/".
  if (path === '/') return LSAT_ROUTE_PREFIX;
  return `${LSAT_ROUTE_PREFIX}${path}`;
}

/**
 * The navigate signature react-router exposes — a `(to, options?)` call plus the
 * numeric-delta overload (`navigate(-1)`). We re-state it so callers get the
 * same ergonomics as `useNavigate()` with LSAT prefixing layered on.
 */
export interface LsatNavigateFunction {
  (to: To, options?: NavigateOptions): void;
  (delta: number): void;
}

/**
 * `useNavigate()` that prefixes app-relative LSAT paths with `/lsat`. Numeric
 * deltas, object `To`s (with their own `pathname`), and already-prefixed/host
 * absolute paths pass through; only a bare string `To` is rewritten via
 * `toLsatPath`.
 */
export function useLsatNavigate(): LsatNavigateFunction {
  const navigate = useNavigate();
  return useCallback<LsatNavigateFunction>(
    (to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') {
        navigate(to);
        return;
      }
      if (typeof to === 'string') {
        navigate(toLsatPath(to), options);
        return;
      }
      // Partial<Path> object form: prefix its pathname if present.
      navigate(
        to.pathname ? { ...to, pathname: toLsatPath(to.pathname) } : to,
        options,
      );
    },
    [navigate],
  );
}
