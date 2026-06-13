import { m, useReducedMotion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { Logo } from "@/components/logo";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { duration, easing } from "@/lib/motion";

/**
 * R9 (docs/19 Study Loop "exam as a ceremony") — the shared pre/post-clock stage.
 *
 * Before R9 each exam threshold (intro / break / section-sealed / done) hand-rolled
 * its own `Logo + h1 + Card` centering. They now share ONE designed frame: a calm
 * full-height stage with a breathing aurora behind the brand mark, an `.type-overline`
 * eyebrow, the title in the serif `.type-display` voice, and an optional serif
 * `.type-counsel` line. Slots (`children`, `aside`, `actions`, `footer`) keep each
 * threshold free to compose its own instruments (the itinerary, the rest ring, the
 * pacing recap) inside one consistent ceremony.
 *
 * Purely a pre/post-clock surface — it renders no question content and carries no
 * Test-Mode risk. Reduced-motion collapses the staged reveal + stills the aurora
 * (the global `@media` net also neutralizes the `aurora-drift` keyframe).
 */
export function Ceremony({
  eyebrow,
  title,
  counsel,
  icon,
  mark = true,
  glyph,
  children,
  aside,
  actions,
  footer,
  className,
}: {
  /** Uppercase overline above the title (e.g. "FULL TIMED EXAM", "INTERMISSION"). */
  eyebrow?: string;
  title: string;
  /** A serif counsel sentence under the title. */
  counsel?: React.ReactNode;
  /** Tinted icon chip rendered above the eyebrow (when `mark` is false). */
  icon?: LucideIcon;
  /** Show the breathing brand mark (default). Set false to lead with `icon`. */
  mark?: boolean;
  /** Extra element rendered beside the mark (e.g. a rest ring overlapping the glyph). */
  glyph?: React.ReactNode;
  /** Primary body — the itinerary, the recap, etc. Centered, width-capped. */
  children?: React.ReactNode;
  /** Secondary cluster under the body (e.g. "up next"). */
  aside?: React.ReactNode;
  /** The primary action row. */
  actions?: React.ReactNode;
  /** A quiet footer line (cancel / keyboard map). */
  footer?: React.ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const stage = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: duration.slow, delay, ease: easing.emphasized },
        };

  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex w-full max-w-xl flex-col items-center">
        {/* The brand mark, breathing inside an aurora — the ceremonial focal glyph. */}
        <m.div className="relative mb-6 inline-flex items-center justify-center" {...stage(0)}>
          {mark ? (
            <span className="aurora relative inline-flex items-center justify-center rounded-full p-3">
              <Logo className="h-12 w-12" />
              {glyph}
            </span>
          ) : icon ? (
            <span className="aurora inline-flex items-center justify-center rounded-card bg-surface-2 p-3 text-primary">
              <Icon as={icon} size="lg" />
              {glyph}
            </span>
          ) : (
            glyph
          )}
        </m.div>

        <m.div className="space-y-2" {...stage(0.06)}>
          {eyebrow && (
            <p className="type-overline text-muted-foreground">{eyebrow}</p>
          )}
          <h1 className="type-display text-3xl leading-tight sm:text-4xl">
            {title}
          </h1>
          {counsel && (
            <p className="type-counsel mx-auto max-w-md text-base text-muted-foreground">
              {counsel}
            </p>
          )}
        </m.div>

        {children && (
          <m.div className="mt-8 w-full" {...stage(0.12)}>
            {children}
          </m.div>
        )}

        {aside && (
          <m.div className="mt-6 w-full" {...stage(0.16)}>
            {aside}
          </m.div>
        )}

        {actions && (
          <m.div
            className="mt-8 flex flex-wrap items-center justify-center gap-2"
            {...stage(0.2)}
          >
            {actions}
          </m.div>
        )}

        {footer && (
          <m.div className="mt-3 text-center" {...stage(0.24)}>
            {footer}
          </m.div>
        )}
      </div>
    </div>
  );
}
