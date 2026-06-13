import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@lsat/lib/utils";
import { duration, easing } from "@lsat/lib/motion";

// R11 2.4 — the sweep tempo from the shared motion tokens (was an inline
// `0.5s cubic-bezier(0.3,0,0,1)` literal): duration.celebrate + easing.emphasized.
const SWEEP_TRANSITION = `stroke-dashoffset ${duration.celebrate}s cubic-bezier(${easing.emphasized.join(",")})`;

export interface ProgressRingProps {
  /** 0..1 */
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  /** Center label; if omitted, shows the percentage. */
  label?: React.ReactNode;
  sublabel?: React.ReactNode;
  className?: string;
}

/** SVG progress ring with an animated sweep and center label. */
export function ProgressRing({
  value,
  size = 96,
  strokeWidth = 8,
  color = "hsl(var(--primary))",
  trackColor = "hsl(var(--muted))",
  label,
  sublabel,
  className,
}: ProgressRingProps) {
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, value));
  const [shown, setShown] = useState(reduce ? clamped : 0);

  useEffect(() => {
    if (reduce) {
      setShown(clamped);
      return;
    }
    const id = requestAnimationFrame(() => setShown(clamped));
    return () => cancelAnimationFrame(id);
  }, [clamped, reduce]);

  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - shown);

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} role="img" aria-label={`${Math.round(clamped * 100)}%`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: reduce ? undefined : SWEEP_TRANSITION }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="stat text-lg font-semibold tabular-nums leading-none">
          {label ?? `${Math.round(clamped * 100)}%`}
        </span>
        {sublabel && (
          <span className="mt-0.5 text-[10px] text-muted-foreground">{sublabel}</span>
        )}
      </div>
    </div>
  );
}
