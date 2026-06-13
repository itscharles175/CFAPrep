import { cn } from "@/lib/utils";

/**
 * R8 (docs/18) — one shared bar for "The Archive". Replaces the three
 * hand-rolled `<div class="h-2 bg-muted"><div bg-primary/bg-warning>` bars
 * (bank progress, fail-reason breakdown, embed coverage) with a single,
 * accessible, token-driven meter.
 *
 * Accessible by construction: the track is a `role="progressbar"` with
 * aria-valuenow/min/max, and an optional label row carries a tabular value.
 * Tones map to semantic tokens so they re-theme across all four themes; we
 * never reach for the violet Verdict accent as a data fill.
 */

type MeterTone = "default" | "success" | "warning" | "info";

const TONE_FILL: Record<MeterTone, string> = {
  default: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
};

const SIZE_H: Record<"sm" | "md", string> = {
  sm: "h-1.5",
  md: "h-2",
};

export function Meter({
  value,
  max = 100,
  tone = "default",
  size = "md",
  label,
  valueText,
  className,
  "aria-label": ariaLabel,
}: {
  /** Current value (same unit as `max`). */
  value: number;
  /** Full-scale value; defaults to 100 so callers can pass a percentage. */
  max?: number;
  tone?: MeterTone;
  size?: "sm" | "md";
  /** Optional leading label rendered above the track. */
  label?: React.ReactNode;
  /** Optional trailing value rendered above the track (right-aligned). */
  valueText?: React.ReactNode;
  className?: string;
  /** Required for a11y when no visible `label` is supplied. */
  "aria-label"?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));
  const showRow = label != null || valueText != null;
  return (
    <div className={cn("space-y-1", className)}>
      {showRow && (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          {label != null ? (
            <span className="text-foreground">{label}</span>
          ) : (
            <span />
          )}
          {valueText != null && (
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {valueText}
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={Math.round(safeMax)}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        className={cn(
          "w-full overflow-hidden rounded-full bg-surface-2",
          SIZE_H[size],
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            TONE_FILL[tone],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
