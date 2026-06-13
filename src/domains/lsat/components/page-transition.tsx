import { m } from "motion/react";
import { pageTransition } from "@/lib/motion";

/**
 * Wraps a routed page so route changes animate via <AnimatePresence>.
 * Reduced-motion is handled globally by <MotionProvider>.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <m.div
      variants={pageTransition}
      initial="hidden"
      animate="show"
      exit="exit"
      className="h-full"
    >
      {children}
    </m.div>
  );
}
