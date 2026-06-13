import { LazyMotion, MotionConfig, domMax } from "motion/react";

/**
 * Global motion configuration. Mount once near the app root.
 *
 * - `LazyMotion features={domMax}` lets animated components import the
 *   lightweight `m` factory instead of the full `motion` one and source their
 *   animation features from here. `strict` makes a stray `motion.*` throw at
 *   render, which keeps the whole app on `m` (no per-component feature
 *   duplication). `domMax` (not `domAnimation`) is required because we rely on
 *   layout animations — the nav active-bar and the animated list.
 * - `MotionConfig reducedMotion="user"` makes every component honor the OS
 *   `prefers-reduced-motion` setting automatically (docs/07 §4 — non-negotiable).
 *
 * NB: under this provider render `m.div` etc., never `motion.div`.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
