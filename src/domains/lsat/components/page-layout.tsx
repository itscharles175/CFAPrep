import type { LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type PageWidth = "md" | "lg" | "xl" | "2xl" | "full";

const widthClass: Record<PageWidth, string> = {
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
  "2xl": "max-w-6xl",
  full: "max-w-none",
};

/**
 * R9 (docs/19 F4.1) — the page-header system. Every screen routes through this,
 * so it carries the app's editorial identity: an optional uppercase `eyebrow`
 * overline, an optional `icon` in a calm graphite chip, and the title in the
 * serif `.type-display` voice (Newsreader optical sizing). All new props are
 * optional, so the 19 existing call sites keep working unchanged.
 */
export function PageLayout({
  title,
  description,
  actions,
  eyebrow,
  icon,
  width = "lg",
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Uppercase overline label above the title (e.g. "LIBRARY"). */
  eyebrow?: string;
  /** A lucide icon rendered in a calm chip beside the title. */
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="mt-1 inline-flex shrink-0 items-center justify-center rounded-card bg-surface-2 p-2 text-muted-foreground">
              <Icon as={icon} size="md" />
            </span>
          )}
          <div className="space-y-1">
            {eyebrow && (
              <p className="type-overline text-muted-foreground">{eyebrow}</p>
            )}
            <h1 className="type-display text-3xl leading-tight [text-wrap:balance]">
              {title}
            </h1>
            {description && (
              <p className="max-w-prose text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
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
