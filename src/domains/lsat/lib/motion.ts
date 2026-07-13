// Motion tokens (docs/07 §4). All consumers should respect prefers-reduced-motion;
// the global <MotionProvider> (MotionConfig) gates this, and individual components
// can additionally read `useReducedMotion()` for finer control.
import type { Transition, Variants } from "motion/react";

export const duration = {
  fast: 0.12,
  base: 0.2,
  slow: 0.32,
  celebrate: 0.5,
} as const;

export const easing = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.3, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

export const spring = {
  press: { type: "spring", stiffness: 400, damping: 30 },
} as const satisfies Record<string, Transition>;

// ---- R10 B2.1 — the tactile micro-interaction layer (motion-driven hover/press).
// Consumers (e.g. <MotionCard>) spread these into whileHover/whileTap, ALWAYS
// gated behind useReducedMotion() — the global CSS net does NOT cover JS springs.
/** A calm spring lift on hover for interactive cards/CTAs. */
export const hoverLift = { y: -3, transition: spring.press } as const;
/** A subtle press-down on tap. */
export const tapPress = { scale: 0.985 } as const;

/** List-item stagger gap (docs/07 §4: 40ms). */
export const STAGGER = 0.04;

// ---- Reusable variants ----

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: easing.emphasized },
  },
  exit: {
    opacity: 0,
    y: 4,
    transition: { duration: duration.fast, ease: easing.exit },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: duration.base, ease: easing.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: easing.exit } },
};

/** Parent container that staggers children using `fadeUp`/`fadeIn`. */
export const stagger: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: STAGGER },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: duration.base, ease: easing.emphasized },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    transition: { duration: duration.fast, ease: easing.exit },
  },
};

/** Page/route transition variant (used by <PageTransition>). */
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: easing.emphasized },
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: duration.fast, ease: easing.exit },
  },
};
