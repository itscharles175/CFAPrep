import { memo } from "react";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { cn } from "@lsat/lib/utils";
import { chartTooltipStyle } from "./chart-kit";

export interface TrapSpiralDatum {
  key: string;
  label: string;
  /** Frequency (e.g. times the trap was chosen). Drives wedge radius. */
  value: number;
  color?: string;
}

export interface TrapSpiralProps {
  data: TrapSpiralDatum[];
  size?: number;
  onSelect?: (d: TrapSpiralDatum) => void;
  className?: string;
}

// Okabe–Ito colorblind-safe palette (matches the app's type-color families in
// lib/labels.ts). NB: the brand Verdict violet is intentionally absent — it is
// reserved for UI accents and must never encode a data category (docs/17 §I).
const PALETTE = [
  "#0072B2",
  "#D55E00",
  "#009E73",
  "#CC79A7",
  "#E69F00",
  "#56B4E9",
  "#F0E442",
  "#374151",
];

function polar(cx: number, cy: number, r: number, angle: number) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
}

/**
 * B6 — radial "trap spiral": a polar-area chart where each trap pattern is a
 * wedge whose radius scales with how often it caught you. Click a wedge to
 * drill that pattern. Colorblind-safe palette; <title> tooltips per wedge.
 */
function TrapSpiralImpl({
  data,
  size = 240,
  onSelect,
  className,
}: TrapSpiralProps) {
  const cx = size / 2;
  const cy = size / 2;
  const pad = 6;
  const rMax = size / 2 - pad;
  const rMin = rMax * 0.18; // small hub so thin wedges stay clickable
  const maxVal = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  const n = data.length;
  const padAngle = n > 1 ? 0.04 : 0;
  const slice = (Math.PI * 2) / Math.max(1, n);

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<TrapSpiralDatum>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  if (!n) return null;

  return (
    <div
      ref={containerRef}
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} role="img" aria-label="Trap frequency spiral">
        {/* Reference rings at 50% / 100% of max */}
        {[0.5, 1].map((f) => (
          <circle
            key={f}
            cx={cx}
            cy={cy}
            r={rMin + (rMax - rMin) * f}
            fill="none"
            stroke="hsl(var(--border))"
            strokeOpacity={0.6}
            strokeDasharray="2,3"
          />
        ))}
        {data.map((d, i) => {
          const a0 = -Math.PI / 2 + i * slice + padAngle / 2;
          const a1 = -Math.PI / 2 + (i + 1) * slice - padAngle / 2;
          const r = rMin + (rMax - rMin) * (d.value / maxVal);
          const [x0, y0] = polar(cx, cy, r, a0);
          const [x1, y1] = polar(cx, cy, r, a1);
          const [ix0, iy0] = polar(cx, cy, rMin, a0);
          const [ix1, iy1] = polar(cx, cy, rMin, a1);
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const path = [
            `M ${ix0},${iy0}`,
            `L ${x0},${y0}`,
            `A ${r},${r} 0 ${large} 1 ${x1},${y1}`,
            `L ${ix1},${iy1}`,
            `A ${rMin},${rMin} 0 ${large} 0 ${ix0},${iy0}`,
            "Z",
          ].join(" ");
          const color = d.color ?? PALETTE[i % PALETTE.length];
          const clickable = !!onSelect;
          // Label anchor at the wedge mid-angle, just outside the hub.
          const mid = (a0 + a1) / 2;
          const [lx, ly] = polar(cx, cy, (rMin + r) / 2, mid);
          return (
            <g key={d.key}>
              <path
                d={path}
                fill={color}
                fillOpacity={tooltipData?.key === d.key ? 1 : 0.85}
                stroke="hsl(var(--background))"
                strokeWidth={1}
                className={clickable ? "cursor-pointer transition-[fill-opacity] hover:[fill-opacity:1]" : "transition-[fill-opacity]"}
                onClick={clickable ? () => onSelect?.(d) : undefined}
                role={clickable ? "button" : undefined}
                aria-label={clickable ? `Drill ${d.label}` : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect?.(d);
                        }
                      }
                    : undefined
                }
                onMouseMove={(e) => {
                  const host = e.currentTarget.ownerSVGElement
                    ?.parentElement as HTMLElement | null;
                  const rect = host?.getBoundingClientRect();
                  showTooltip({
                    tooltipData: d,
                    tooltipLeft: e.clientX - (rect?.left ?? 0),
                    tooltipTop: e.clientY - (rect?.top ?? 0),
                  });
                }}
                onMouseLeave={hideTooltip}
              >
                {/* a11y / no-JS fallback mirroring the kit tooltip. */}
                <title>{`${d.label}: ${d.value}`}</title>
              </path>
              {d.value / maxVal > 0.28 && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="hsl(var(--background))"
                  className="pointer-events-none font-medium"
                >
                  {d.value}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipInPortal left={tooltipLeft} top={tooltipTop} style={chartTooltipStyle}>
          <div className="font-medium">{tooltipData.label}</div>
          <div className="tabular-nums text-muted-foreground">
            {tooltipData.value}× chosen
            {total > 0 ? ` · ${Math.round((tooltipData.value / total) * 100)}% of traps` : ""}
          </div>
          <div className="mt-1 max-w-[22ch] text-muted-foreground">
            {tooltipData.value >= maxVal
              ? "Your most frequent trap — prioritise it."
              : "A recurring pull on wrong answers."}
          </div>
        </TooltipInPortal>
      )}
    </div>
  );
}

// A2.4 — memoized: the polar wedge geometry only depends on `data`/`size`, so a
// Traps-tab re-render won't recompute every wedge unless the data changes.
export const TrapSpiral = memo(TrapSpiralImpl);
TrapSpiral.displayName = "TrapSpiral";
