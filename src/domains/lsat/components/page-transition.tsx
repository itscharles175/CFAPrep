import { m, useReducedMotion } from "motion/react";
import { pageTransition } from "@lsat/lib/motion";

/**
 * Wraps a routed page so route changes animate via <AnimatePresence>.
 * Reduced-motion is handled globally by <MotionProvider>.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();

  return (
    <m.div
      // MotionConfig removes transform motion, but explicitly skipping the
      // variants also avoids a fade between assessment surfaces for people who
      // request reduced motion.
      variants={reduce ? undefined : pageTransition}
      initial={reduce ? false : "hidden"}
      animate={reduce ? undefined : "show"}
      exit={reduce ? undefined : "exit"}
      className="h-full"
    >
      {children}
    </m.div>
  );
}
