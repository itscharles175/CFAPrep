import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { fadeUp } from "@lsat/lib/motion";
import { cn } from "@lsat/lib/utils";

/**
 * R9 (docs/19 F2.4) — list choreography. Animates add / remove / reorder of list
 * items with a calm fadeUp + `layout` morph, so queues (SRS due, flagged,
 * playlists, recommendation inbox) stop hard-cutting on mutation. Reduced-motion
 * renders a plain list with no animation. Items need a stable key.
 */
export function AnimatedList<T>({
  items,
  getKey,
  renderItem,
  className,
  itemClassName,
}: {
  items: T[];
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  itemClassName?: string;
}) {
  const reduce = useReducedMotion();

  if (reduce) {
    return (
      <div className={className}>
        {items.map((item, i) => (
          <div key={getKey(item, i)} className={itemClassName}>
            {renderItem(item, i)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={className}>
      <AnimatePresence initial={false}>
        {items.map((item, i) => (
          <m.div
            key={getKey(item, i)}
            layout
            variants={fadeUp}
            initial="hidden"
            animate="show"
            exit="exit"
            className={cn(itemClassName)}
          >
            {renderItem(item, i)}
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
