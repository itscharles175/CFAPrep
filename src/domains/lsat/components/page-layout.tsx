import type { LucideIcon } from "lucide-react";
import { cn } from "@lsat/lib/utils";
import { PageHeader } from "@/components/ui/Primitives";

export type PageWidth = "md" | "lg" | "xl" | "2xl" | "full";

const widthClass: Record<PageWidth, string> = {
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
  "2xl": "max-w-6xl",
  full: "max-w-none",
};

/**
 * A4 (UIv2) — the page header now DELEGATES to the host <PageHeader>. The K4
 * reskin moved 14 LSAT pages onto the host header (StatusBadge eyebrow + host sans
 * title + subtitle + ActionBar); the last three on this component (Analytics,
 * Explanation, Import) were the only screens still rendering the legacy serif
 * `.type-display` title + overline eyebrow. Delegating here closes that seam for
 * all three at once with no call-site churn, while preserving this component's
 * content WIDTH-WRAPPER (mx-auto max-w-* + vertical rhythm) so nothing below the
 * header shifts. The `eyebrow` maps to PageHeader's badge; `description` to its
 * subtitle. `icon` is accepted for call-site compatibility but no longer rendered
 * — the unified host header carries a badge, not an icon chip.
 */
export function PageLayout({
  title,
  description,
  actions,
  eyebrow,
  width = "lg",
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Uppercase overline label above the title (rendered as a host StatusBadge). */
  eyebrow?: string;
  /** Accepted for API compatibility; the unified host header renders no icon. */
  icon?: LucideIcon;
  width?: PageWidth;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // R11 3.1 — density-responsive vertical rhythm (the old `density-gap`
        // was a no-op `gap` on a block container; this actually compacts).
        "mx-auto space-y-[calc(var(--space-unit)*4)]",
        widthClass[width],
        className,
      )}
    >
      <PageHeader eyebrow={eyebrow} title={title} subtitle={description} actions={actions} />
      {children}
    </div>
  );
}

/**
 * A grouping header inside a page (e.g. Settings sections). Mirrors the page
 * header's voice one level down: optional eyebrow + a serif `.type-display`
 * section title + optional description/actions.
 */
export function PageSection({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          {eyebrow && (
            <p className="type-overline text-muted-foreground">{eyebrow}</p>
          )}
          <h2 className="type-display text-lg leading-snug [text-wrap:balance]">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
