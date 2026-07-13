import type { ReactNode } from 'react';
import { cn } from './chart-kit';

/**
 * ANL-5 — host-styled ReadinessGauge, promoted from the LSAT viz barrel.
 *
 * Multi-ring composite gauge (e.g. accuracy / volume / consistency / SRS
 * health) — each dimension a concentric progress arc filled clockwise from 12
 * o'clock. Restyled onto host tokens; the `motion`-driven sweep was dropped for
 * a plain SVG render (the host page does not animate these), keeping the same
 * per-ring `<title>` for the accessibility tree.
 */

export interface ReadinessRing {
  name: string;
  /** 0..1 fill. */
  value: number;
  /** Arc color (any CSS color; pass a host token like `var(--accent)`). */
  color: string;
}

export interface ReadinessGaugeProps {
  rings: ReadinessRing[];
  size?: number;
  strokeWidth?: number;
  /** Radial gap between concentric rings (px). */
  gap?: number;
  centerTop?: ReactNode;
  centerBottom?: ReactNode;
  className?: string;
}

export function ReadinessGauge({
  rings,
  size = 132,
  strokeWidth = 9,
  gap = 4,
  centerTop,
  centerBottom,
  className,
}: ReadinessGaugeProps) {
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - strokeWidth / 2 - 1;

  return (
    <div
      className={cn(className)}
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center', width: size, height: size }}
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
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} opacity={0.5} />
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={`${filled} ${Math.max(0, c - filled)}`}
                >
                  <title>{`${ring.name}: ${Math.round(v * 100)}%`}</title>
                </circle>
              </g>
            );
          })}
        </g>
      </svg>
      {(centerTop || centerBottom) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            lineHeight: 1,
            pointerEvents: 'none',
          }}
        >
          {centerTop}
          {centerBottom}
        </div>
      )}
    </div>
  );
}
