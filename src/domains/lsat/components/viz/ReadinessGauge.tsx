import type { ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { duration, easing } from "@/lib/motion";
import type { ReadinessRing } from "@/lib/readiness";

export interface ReadinessGaugeProps {
  rings: ReadinessRing[];
  size?: number;
  strokeWidth?: number;
  /** Radial gap between concentric rings (px). */
  gap?: number;
  centerTop?: ReactNode;
  centerBottom?: ReactNode;
  /**
   * R9 §6 — sweep each arc clockwise on mount (dash-offset trace-in). Strictly
   * reduced-motion gated; off by default so existing call sites are unchanged.
   */
  animate?: boolean;
  className?: string;
}

/**
 * B7 — multi-ring composite gauge (accuracy / volume / consistency / SRS
 * health). Each dimension is a concentric progress arc, filled clockwise from
 * 12 o'clock. Replaces the single-number readiness bar.
 */
export function ReadinessGauge({
  rings,
  size = 132,
  strokeWidth = 9,
  gap = 4,
  centerTop,
  centerBottom,
  animate = false,
  className,
}: ReadinessGaugeProps) {
  const reduce = useReducedMotion();
  const doAnimate = animate && !reduce;
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - strokeWidth / 2 - 1;

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} role="img" aria-label="Readiness composite">
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {rings.map((ring, i) => {
            const r = outer - i * (strokeWidth + gap);
            if (r <= 0) return null;
            const c = 2 * Math.PI * r;
            const v = Math.max(0, Math.min(1, ring.value));
            const filled = v * c;
            return (
              <g key={ring.name}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke="hsl(var(--muted))"
                  strokeWidth={strokeWidth}
                  opacity={0.5}
                />
                <m.circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={`${filled} ${Math.max(0, c - filled)}`}
                  initial={doAnimate ? { strokeDashoffset: filled } : false}
                  animate={doAnimate ? { strokeDashoffset: 0 } : undefined}
                  transition={
                    doAnimate
                      ? { duration: duration.slow, ease: easing.emphasized, delay: i * 0.06 }
                      : undefined
                  }
                >
                  <title>{`${ring.name}: ${Math.round(v * 100)}%`}</title>
                </m.circle>
              </g>
            );
          })}
        </g>
      </svg>
      {(centerTop || centerBottom) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center leading-none">
          {centerTop}
          {centerBottom}
        </div>
      )}
    </div>
  );
}
