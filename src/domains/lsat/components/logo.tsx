import { cn } from "@lsat/lib/utils";

/**
 * R8 brand mark (docs/18 W2.1). The app shipped a bespoke, display-P3 violet
 * "aurora flask" glyph in public/favicon.svg but rendered a stock lucide
 * FlaskConical everywhere. This promotes the real mark. The SVG is a multi-color
 * volumetric glyph (not a monochrome icon), so it's rendered as an <img> to
 * preserve its designed gradients/glow rather than flattened to currentColor.
 *
 * `size` accepts a px number; pass a Tailwind size via `className` (h-6 w-6) to
 * match the call sites that previously sized the lucide icon.
 */
export function Logo({
  size,
  className,
  withWordmark = false,
  wordmarkClassName,
}: {
  size?: number;
  className?: string;
  withWordmark?: boolean;
  wordmarkClassName?: string;
}) {
  const img = (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0 select-none", className)}
      draggable={false}
    />
  );
  if (!withWordmark) return img;
  return (
    <span className="inline-flex items-center gap-2">
      {img}
      <span
        className={cn(
          "font-semibold tracking-tight leading-none",
          wordmarkClassName,
        )}
      >
        LSAT&nbsp;Lab
      </span>
    </span>
  );
}
