import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@lsat/lib/utils";
import { duration } from "@lsat/lib/motion";

export interface StatNumberProps {
  value: number | null | undefined;
  /** Decimal places to render. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Optional delta chip (▲/▼ + value), colored by sign. */
  delta?: number | null;
  /** Format the delta number (defaults to the same decimals). */
  deltaSuffix?: string;
  label?: string;
  className?: string;
  /** stat (48px) or stat-xl (64px). */
  size?: "stat" | "stat-xl";
  /**
   * R8 — engrave the numeral as the mono tabular voice (`.type-numeric`)
   * instead of the default sans. Purely cosmetic; count-up is unchanged.
   */
  voice?: "sans" | "numeric";
  /**
   * R8 — wrap the numeral in `.aurora` so a faint verdict glow breathes
   * behind it (auto-off in high-contrast / reduced motion via CSS).
   */
  aurora?: boolean;
  /**
   * R8 — one short serif counsel line beneath the figure (`.type-counsel`).
   * Caller supplies copy derived from existing data — no new data here.
   */
  subline?: ReactNode;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/** Big tabular number with count-up on mount + optional delta chip. */
export function StatNumber({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  delta,
  deltaSuffix = "",
  label,
  className,
  size = "stat",
  voice = "sans",
  aurora = false,
  subline,
}: StatNumberProps) {
  const reduce = useReducedMotion();
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const numericValue = hasValue ? value : 0;
  const [display, setDisplay] = useState(reduce ? numericValue : 0);
  const raf = useRef<number>();

  useEffect(() => {
    if (!hasValue) {
      setDisplay(0);
      return;
    }
    if (reduce) {
      setDisplay(numericValue);
      return;
    }
    const start = performance.now();
    const dur = duration.slow * 1000;
    const from = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      setDisplay(from + (numericValue - from) * easeOutCubic(p));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [hasValue, numericValue, reduce]);

  const formatted = hasValue
    ? display.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : "n/a";

  const deltaValue = typeof delta === "number" && Number.isFinite(delta) ? delta : 0;
  const hasDelta = deltaValue !== 0;
  const up = deltaValue > 0;

  const numeral = (
    <div className="flex items-baseline gap-2">
      <span
        className={cn(
          "stat leading-none tabular-nums",
          voice === "numeric"
            ? "type-numeric font-semibold"
            : "font-sans font-semibold tracking-tight",
          size === "stat" ? "text-stat" : "text-stat-xl",
        )}
      >
        {prefix}
        {formatted}
        {suffix}
      </span>
      {hasDelta && (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-chip px-1.5 py-0.5 text-xs font-semibold tabular-nums",
            up
              ? "bg-success-subtle text-success"
              : "bg-destructive-subtle text-destructive",
          )}
        >
          {up ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {Math.abs(deltaValue).toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })}
          {deltaSuffix}
        </span>
      )}
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <span className="type-overline text-muted-foreground">{label}</span>
      )}
      {aurora ? <div className="aurora">{numeral}</div> : numeral}
      {subline && (
        <p className="type-counsel mt-1 max-w-prose text-sm text-muted-foreground">
          {subline}
        </p>
      )}
    </div>
  );
}
