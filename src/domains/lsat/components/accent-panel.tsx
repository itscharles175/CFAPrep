import { cn } from "@/lib/utils";

/**
 * R10 B3.2 — one primitive for the "primary verdict-accented hero panel" idiom
 * that was hand-rolled ≥4 ways with different radii/tints (ResumeHero used
 * `rounded-xl` — a literal corner seam vs the system's `rounded-card`). Aurora
 * glow + verdict edge + the subtle accent tint, on the system radius. Set
 * `breathe` for the single hero instance (animated aurora); otherwise static.
 */
export function AccentPanel({
  className,
  breathe = false,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { breathe?: boolean }) {
  return (
    <div
      className={cn(
        "aurora relative overflow-hidden rounded-card border border-primary/25 bg-primary-subtle p-5",
        breathe && "aurora-breathe",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
