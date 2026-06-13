import { Inbox, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Logo } from "@/components/logo";
import { IllustrationError, IllustrationOffline } from "@/components/illustrations";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// R8 "system status" — error / offline / AI-prereq / empty / loading states all
// speak one calm visual language: a consistent <Icon> stroke, semantic-subtle
// token backgrounds (no ad-hoc /5 /10 opacity), and shared spacing.
// ---------------------------------------------------------------------------

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  // R8 "First Light" loading identity (docs/18 W5.2): the brand mark catching a
  // calm aurora instead of a generic spinner. Reduced-motion stills the breath.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col items-center justify-center gap-4 py-16 text-muted-foreground"
    >
      <span className="aurora relative inline-flex items-center justify-center">
        <Logo className="h-10 w-10 animate-pulse-soft motion-reduce:animate-none" />
      </span>
      <span className="flex items-center gap-2 text-sm">
        <Icon as={Loader2} size="sm" className="animate-spin motion-reduce:animate-none" />
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeletons (shimmer). The shimmer keyframe is defined in tailwind.config.js
// and is automatically suppressed when prefers-reduced-motion is set via the
// media query below.
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        "before:absolute before:inset-0 before:-translate-x-full",
        "before:animate-shimmer before:bg-gradient-to-r",
        "before:from-transparent before:via-foreground/10 before:to-transparent",
        "motion-reduce:before:animate-none",
        className,
      )}
    />
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-card border bg-card p-4", className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

export function SkeletonChart({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-card border bg-card p-4", className)}>
      <Skeleton className="mb-3 h-4 w-1/4" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function SkeletonList({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// R9 (docs/19 F2.2) — route-shaped skeletons. Every lazy route used to flash the
// centered LoadingState (a spinner that ignores the page it's becoming), so the
// shell appeared to "jump" when content arrived. These mirror the real page
// chrome — a PageLayout-shaped header (eyebrow + serif title + description),
// then a list/grid or a detail body — so the lazy-load reads as the page
// *settling in* rather than a blank gap. They compose the primitives above and
// inherit the reduced-motion shimmer suppression for free.
// ---------------------------------------------------------------------------

const PAGE_WIDTH: Record<"md" | "lg" | "xl" | "2xl" | "full", string> = {
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
  "2xl": "max-w-6xl",
  full: "max-w-none",
};

/** A PageLayout-shaped header block (icon chip + eyebrow + title + blurb). */
function SkeletonPageHeader({ withIcon = true }: { withIcon?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {withIcon && (
          <Skeleton className="mt-1 h-9 w-9 shrink-0 rounded-card" />
        )}
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-9 w-28 rounded-md" />
    </div>
  );
}

/**
 * Generic list / index page (PrepTests, Drills, Bank, Quarantine, history…):
 * a page header over a responsive card grid. `aria-busy` + a polite live label
 * keep it announced like LoadingState.
 */
export function SkeletonListPage({
  cards = 6,
  width = "xl",
  className,
}: {
  cards?: number;
  width?: "md" | "lg" | "xl" | "2xl" | "full";
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "mx-auto space-y-6 density-gap",
        PAGE_WIDTH[width],
        className,
      )}
    >
      <span className="sr-only">Loading…</span>
      <SkeletonPageHeader />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Generic detail / single-record page (Explanation, TypeAnalytics,
 * PrepTestAnalytics, Settings…): a page header over a wide primary panel and a
 * narrow side rail, then a couple of stacked text blocks.
 */
export function SkeletonDetailPage({
  width = "lg",
  className,
}: {
  width?: "md" | "lg" | "xl" | "2xl" | "full";
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "mx-auto space-y-6 density-gap",
        PAGE_WIDTH[width],
        className,
      )}
    >
      <span className="sr-only">Loading…</span>
      <SkeletonPageHeader />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 rounded-card border bg-card p-4 lg:col-span-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-10/12" />
          <Skeleton className="h-3 w-9/12" />
          <Skeleton className="h-40 w-full" />
        </div>
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </div>
  );
}

/**
 * Full-bleed exam loading screen (TakeSection / Exam / BlindReview): mirrors the
 * exam frame — a slim top toolbar, a tall reading column beside an answer panel,
 * and a footer nav strip — so starting a section doesn't hard-cut from a
 * centered spinner into a dense two-pane layout. Fills its container.
 */
export function SkeletonExam({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "flex h-full min-h-[28rem] w-full flex-col bg-background",
        className,
      )}
    >
      <span className="sr-only">Loading exam…</span>
      {/* top toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-md" />
        </div>
      </div>
      {/* two-pane body */}
      <div className="grid min-h-0 flex-1 gap-px bg-border md:grid-cols-2">
        <div className="space-y-3 overflow-hidden bg-background p-6">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className={cn("h-3", i % 3 === 2 ? "w-9/12" : "w-full")} />
          ))}
        </div>
        <div className="space-y-4 overflow-hidden bg-background p-6">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <div className="space-y-2.5 pt-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
      {/* footer nav strip */}
      <div className="flex h-14 shrink-0 items-center justify-between border-t px-4">
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — icon/illustration slot + title + description + action.
// ---------------------------------------------------------------------------

export function EmptyState({
  title = "Nothing here yet",
  description,
  action,
  icon,
  illustration,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  /** A lucide (or any) icon node; defaults to an inbox. */
  icon?: React.ReactNode;
  /** A larger custom illustration slot (overrides `icon` if provided). */
  illustration?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-card border border-dashed py-16 text-center",
        className,
      )}
    >
      {illustration ? (
        <div className="mb-1">{illustration}</div>
      ) : (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon ?? <Icon as={Inbox} size="lg" />}
        </div>
      )}
      <div className="text-base font-semibold">{title}</div>
      {description && (
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  illustration,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Override the default bespoke art (offline → IllustrationOffline, else error). */
  illustration?: React.ReactNode;
}) {
  const isApi = error instanceof ApiError;
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  const offline = isApi
    ? false
    : message.toLowerCase().includes("fetch") ||
      message.toLowerCase().includes("network");

  return (
    <div
      role="alert"
      className="bg-destructive-subtle flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-destructive/40 py-12 text-center"
    >
      {/* R10 C1 — bespoke art (was a bare lucide triangle on all 17 call sites). */}
      <div className="mb-1">
        {illustration ?? (offline ? <IllustrationOffline /> : <IllustrationError />)}
      </div>
      <div className="text-sm font-medium text-destructive">
        {offline ? "Backend not reachable" : "Could not load data"}
      </div>
      <div className="max-w-md text-sm text-muted-foreground">
        {offline
          ? "Is the LSAT Lab backend running at the configured address? You can keep building UI; data will appear once it is up."
          : message}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
