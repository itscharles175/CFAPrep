import { type ComponentProps } from "react";
import { m, useReducedMotion } from "motion/react";
import { hoverLift, tapPress } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * R10 B2.1 — the tactile micro-interaction layer. A motion-driven hover-lift +
 * press, for genuinely-clickable cards/CTAs (the difference between "web app" and
 * "native-feeling app"). Reduced-motion drops the springs entirely (the global
 * CSS net does NOT cover motion/react springs, so this guards explicitly).
 *
 * Use only where a real click target exists (no false affordance). Pairs with the
 * `card-interactive` CSS class for the resting shadow/edge.
 */
export function MotionCard({
  className,
  children,
  ...props
}: ComponentProps<typeof m.div>) {
  const reduce = useReducedMotion();
  return (
    <m.div
      whileHover={reduce ? undefined : hoverLift}
      whileTap={reduce ? undefined : tapPress}
      className={cn(className)}
      {...props}
    >
      {children}
    </m.div>
  );
}
