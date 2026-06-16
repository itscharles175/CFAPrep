import { memo, useMemo } from 'react';
import { scaleLinear } from 'd3-scale';
import { Check, X } from 'lucide-react';
import { cn, ChartLegend, VIZ_TOKENS } from './chart-kit';

/**
 * ANL-5 — host-styled HeatStrip, promoted from the LSAT viz barrel.
 *
 * A row of per-item cells colored by value (e.g. time-on-task, pressure), with
 * optional correct/incorrect marks. The LSAT original used the viridis/inferno
 * `useChartScales` ramp; this host version blends the host accent token at a
 * value-driven opacity so it re-themes with the rest of the app and never
 * collides with the surface. A small end-labeled scale key sits below.
 */

export interface HeatCell {
  /** Numeric value driving the cell intensity. */
  value: number;
  /** Whether the item was answered correctly (renders a mark). */
  correct?: boolean;
  /** Optional label for the aria-label/legend (e.g. "Q3"). */
  label?: string;
}

export interface HeatStripProps {
  cells: HeatCell[];
  /** Base color for the ramp (defaults to the host accent token). */
  color?: string;
  /** Override value domain; otherwise computed from data. */
  domain?: [number, number];
  cellSize?: number;
  gap?: number;
  /** Show the low/high scale key (default true). */
  showScaleKey?: boolean;
  scaleLabels?: { low: string; high: string };
  className?: string;
}

/** Convert a base CSS color + opacity into an rgba()/color-mix swatch. The host
 *  tokens are CSS variables, so we layer opacity via `color-mix` against the
 *  surface, falling back to the raw color when color-mix is unsupported. */
function tint(base: string, t: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return `color-mix(in srgb, ${base} ${pct}%, transparent)`;
}

function HeatStripImpl({
  cells,
  color = VIZ_TOKENS.accent,
  domain,
  cellSize = 26,
  gap = 3,
  showScaleKey = true,
  scaleLabels,
  className,
}: HeatStripProps) {
  const colorAt = useMemo(() => {
    const vals = cells.map((c) => c.value);
    const dom = domain ?? [Math.min(...vals), Math.max(...vals)];
    const t = scaleLinear().domain(dom).range([0.12, 1]).clamp(true);
    return (v: number) => tint(color, t(v));
  }, [cells, domain, color]);

  return (
    <div className={cn(className)} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap }}>
        {cells.map((c, i) => {
          const bg = colorAt(c.value);
          return (
            <div
              key={i}
              role="img"
              aria-label={`${c.label ?? `#${i + 1}`}: ${c.value}${c.correct === undefined ? '' : c.correct ? ', correct' : ', incorrect'}`}
              style={{
                width: cellSize,
                height: cellSize,
                borderRadius: 4,
                backgroundColor: bg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title={`${c.label ?? `#${i + 1}`}: ${c.value}`}
            >
              {c.correct === true && <Check size={12} style={{ color: VIZ_TOKENS.text }} />}
              {c.correct === false && <X size={12} style={{ color: VIZ_TOKENS.text }} />}
            </div>
          );
        })}
      </div>
      {showScaleKey && cells.length > 0 && (
        <ChartLegend
          className="qv-mt-2"
          items={[
            { label: scaleLabels?.low ?? 'low', color: tint(color, 0.2) },
            { label: scaleLabels?.high ?? 'high', color: tint(color, 1) },
          ]}
        />
      )}
    </div>
  );
}

// Memoized: the per-cell ramp only recomputes when cells/color/domain change.
export const HeatStrip = memo(HeatStripImpl);
HeatStrip.displayName = 'HeatStrip';
