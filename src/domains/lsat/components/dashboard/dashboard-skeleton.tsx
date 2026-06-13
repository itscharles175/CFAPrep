import { Skeleton } from "@/components/states";

/**
 * R8 — layout-faithful Dashboard loading state. Mirrors the real composition
 * (resume band → engraved predicted-score hero → trend + countdown row → the
 * two-column grid) so the first paint reserves the same boxes the loaded
 * dashboard fills, eliminating the layout shift the centered spinner caused.
 *
 * Pure chrome: every block is a token-driven <Skeleton> (shimmer auto-stilled
 * under prefers-reduced-motion via tailwind + the app-wide CSS net), aria-hidden
 * by construction. The surrounding <PageLayout> still owns the role="status".
 */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6 pb-12" aria-hidden>
      {/* Resume-first hero band */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border bg-card p-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-56" />
        </div>
        <Skeleton className="h-11 w-40 rounded-md" />
      </div>

      {/* Engraved predicted-score hero (label + big numeral + counsel line) */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-16 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      {/* Trend (2col) + countdown (1col) */}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-4 rounded-card border bg-card p-6 md:col-span-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-[240px] w-full" />
        </div>
        <div className="space-y-4 rounded-card border bg-card p-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>

      {/* Study nudge strip */}
      <Skeleton className="h-16 w-full rounded-card" />

      {/* Two-column grid (readiness + recommendations / weakest-types + plan) */}
      <div className="grid gap-6 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-3 rounded-card border bg-card p-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
