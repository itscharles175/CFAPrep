import { type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * R8 W3.3 — the shared chart kit. One tooltip identity, one legend grammar, one
 * reference-line look across every chart, all token-driven so they re-theme in
 * all four environments (dark / light / dark-hc / light-hc) for free.
 */

// ---------------------------------------------------------------------------
// ChartTooltip — ONE popover identity (hsl(var(--popover)) + shadow-e2 +
// rounded-card). Charts using @visx/tooltip's TooltipInPortal should spread
// `chartTooltipStyle` into its `style` prop; charts rendering their own HTML
// overlay can use the <ChartTooltip> component directly.
// ---------------------------------------------------------------------------

/** Inline style for @visx TooltipInPortal so portal tooltips match the kit. */
export const chartTooltipStyle: CSSProperties = {
  position: "absolute",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  border: "1px solid hsl(var(--border))",
  boxShadow: "var(--elevation-2)",
  fontSize: 12,
  lineHeight: 1.35,
  borderRadius: "var(--radius)",
  padding: "6px 8px",
  pointerEvents: "none",
};

export interface ChartTooltipProps {
  /** Absolute x within the chart container. */
  left?: number;
  /** Absolute y within the chart container. */
  top?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Standalone HTML tooltip with the kit's single popover identity. */
export function ChartTooltip({
  left,
  top,
  children,
  className,
  style,
}: ChartTooltipProps) {
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-10 rounded-card border border-border bg-popover px-2 py-1.5 text-xs leading-snug text-popover-foreground shadow-e2",
        className,
      )}
      style={{
        left,
        top,
        transform: left != null || top != null ? "translate(-50%, -120%)" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartLegend — categorical key (swatch + label), supports a redundant shape
// glyph for colourblind safety.
// ---------------------------------------------------------------------------

export interface LegendItem {
  label: string;
  /** Swatch fill (any CSS colour). */
  color: string;
  /** Optional redundant glyph (e.g. ✓/✕ or a shape) for non-colour encoding. */
  glyph?: ReactNode;
  /** Render the swatch hollow (outline only) — pairs with a "filled" sibling. */
  hollow?: boolean;
  /** Render the swatch as a dashed line instead of a dot. */
  dashed?: boolean;
}

export interface ChartLegendProps {
  items: LegendItem[];
  className?: string;
}

/** Horizontal categorical legend used beneath/alongside a chart. */
export function ChartLegend({ items, className }: ChartLegendProps) {
  return (
    <ul
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {items.map((it, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          {it.dashed ? (
            <span
              className="inline-block h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: it.color }}
            />
          ) : (
            <span
              className={cn(
                "inline-flex h-3 w-3 items-center justify-center rounded-sm",
                it.hollow && "border-2",
              )}
              style={
                it.hollow
                  ? { borderColor: it.color }
                  : { backgroundColor: it.color }
              }
            >
              {it.glyph}
            </span>
          )}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// ColorScaleKey — continuous ramp legend for the heatmaps (which had NONE).
// Renders the same theme-safe ramp the chart uses (pass a `colorAt` fn that
// maps t∈[0,1] → swatch), with low/high end labels and an optional zero swatch.
// ---------------------------------------------------------------------------

export interface ColorScaleKeyProps {
  /** Colour function for normalised t ∈ [0,1] (e.g. from useChartScales). */
  colorAt: (t: number) => string;
  /** Label for the low (t=0) end. */
  lowLabel: string;
  /** Label for the high (t=1) end. */
  highLabel: string;
  /** Optional caption above the bar. */
  caption?: string;
  /** Number of discrete steps to render (default 7). */
  steps?: number;
  /** Optional "no data"/zero swatch shown before the ramp. */
  zeroLabel?: string;
  zeroColor?: string;
  className?: string;
}

/** Continuous colour-scale legend (gradient swatch bar + end labels). */
export function ColorScaleKey({
  colorAt,
  lowLabel,
  highLabel,
  caption,
  steps = 7,
  zeroLabel,
  zeroColor,
  className,
}: ColorScaleKeyProps) {
  const swatches = Array.from({ length: steps }, (_, i) =>
    colorAt(steps === 1 ? 0 : i / (steps - 1)),
  );
  return (
    <div className={cn("text-[11px] text-muted-foreground", className)}>
      {caption && <div className="mb-1">{caption}</div>}
      <div className="flex items-center gap-2">
        {zeroLabel && zeroColor && (
          <span className="inline-flex items-center gap-1">
            <span
              className="h-3 w-3 rounded-sm border border-border"
              style={{ backgroundColor: zeroColor }}
            />
            {zeroLabel}
          </span>
        )}
        <span>{lowLabel}</span>
        <span
          className="flex h-3 overflow-hidden rounded-sm border border-border"
          role="img"
          aria-label={`Colour scale from ${lowLabel} to ${highLabel}`}
        >
          {swatches.map((c, i) => (
            <span
              key={i}
              className="h-full w-4"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReferenceLine — SVG marker line (e.g. goal, median, exam date) with an
// optional label. Token-driven; reduced-motion safe (static).
// ---------------------------------------------------------------------------

export interface ReferenceLineProps {
  /** Orientation. */
  orientation?: "vertical" | "horizontal";
  /** For vertical: the x; for horizontal: the y (in chart coords). */
  at: number;
  /** Length of the line (innerH for vertical, innerW for horizontal). */
  length: number;
  /** Offset of the start of the line along the cross-axis. */
  start?: number;
  stroke?: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  label?: string;
  /** Where to anchor the label text relative to the line end. */
  labelAnchor?: "start" | "middle" | "end";
  labelColor?: string;
  fontSize?: number;
}

/** A reference line (goal/median/exam) drawn inside an SVG <Group>. */
export function ReferenceLine({
  orientation = "vertical",
  at,
  length,
  start = 0,
  stroke = "hsl(var(--primary))",
  strokeWidth = 1,
  dash = "3,3",
  opacity = 0.7,
  label,
  labelAnchor = "middle",
  labelColor = "hsl(var(--muted-foreground))",
  fontSize = 9,
}: ReferenceLineProps) {
  const isV = orientation === "vertical";
  const x1 = isV ? at : start;
  const x2 = isV ? at : start + length;
  const y1 = isV ? start : at;
  const y2 = isV ? start + length : at;
  return (
    <>
      <line
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        strokeOpacity={opacity}
      />
      {label && (
        <text
          x={isV ? at : x2}
          y={isV ? start - 2 : at - 2}
          textAnchor={labelAnchor}
          fontSize={fontSize}
          fill={labelColor}
        >
          {label}
        </text>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ChartAnnotation — R9 §2: a small SVG "pin" calling out a single point on a
// chart (personal-best, the start of an improving run, the biggest jump). A
// stem from the datum up to a token-colored dot + a chip label, anchored so it
// stays inside the plot. Pure SVG so it drops inside any <Group>; reduced-motion
// safe (static). Caller positions it in chart coordinates and de-overlaps.
// ---------------------------------------------------------------------------

export type ChartAnnotationTone = "primary" | "success" | "info";

const ANNOTATION_STROKE: Record<ChartAnnotationTone, string> = {
  primary: "hsl(var(--primary))",
  success: "hsl(var(--success))",
  info: "hsl(var(--info))",
};

export interface ChartAnnotationProps {
  /** Datum position in chart coords (px). */
  x: number;
  y: number;
  /** Short label rendered in the chip (e.g. "Personal best"). */
  label: string;
  /** Token tone for the dot/stem. */
  tone?: ChartAnnotationTone;
  /** Vertical lift of the chip above the datum (px). */
  lift?: number;
  /** Plot inner width — used to keep the chip from clipping at the edges. */
  innerW: number;
  /** Approximate label width budget (px) for edge-clamping. */
  labelWidth?: number;
  fontSize?: number;
}

/** A callout pin (stem + dot + chip) for a single charted datum. */
export function ChartAnnotation({
  x,
  y,
  label,
  tone = "primary",
  lift = 22,
  innerW,
  labelWidth = 76,
  fontSize = 9,
}: ChartAnnotationProps) {
  const stroke = ANNOTATION_STROKE[tone];
  const chipY = Math.max(2, y - lift);
  // Clamp the chip horizontally so it never spills past the plot edges.
  const half = labelWidth / 2;
  const chipX = Math.min(Math.max(x, half + 1), Math.max(half + 1, innerW - half - 1));
  const padX = 5;
  const chipH = fontSize + 7;
  return (
    <g aria-hidden className="pointer-events-none">
      {/* stem */}
      <line
        x1={x}
        x2={x}
        y1={y - 3}
        y2={chipY + chipH / 2}
        stroke={stroke}
        strokeWidth={1}
        strokeOpacity={0.5}
        strokeDasharray="2,2"
      />
      {/* datum dot */}
      <circle cx={x} cy={y} r={3.5} fill={stroke} stroke="hsl(var(--card))" strokeWidth={1.5} />
      {/* chip */}
      <g transform={`translate(${chipX}, ${chipY})`}>
        <rect
          x={-(label.length * (fontSize * 0.55)) / 2 - padX}
          y={-chipH / 2}
          width={label.length * (fontSize * 0.55) + padX * 2}
          height={chipH}
          rx={chipH / 2}
          fill="hsl(var(--popover))"
          stroke={stroke}
          strokeOpacity={0.5}
        />
        <text
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={600}
          fill="hsl(var(--popover-foreground))"
        >
          {label}
        </text>
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// ChartEmpty — R9 §3: ONE empty/low-data state for charts that otherwise
// `return null` on thin data. A faint ghost-grid SVG (so the slot keeps its
// shape and doesn't collapse) under a short message + optional hint, all
// token-driven. Replaces the silent collapses that made a new user's
// Timing/Traps tabs look broken.
// ---------------------------------------------------------------------------

export interface ChartEmptyProps {
  /** One-line headline (e.g. "Not enough sessions yet"). */
  title: string;
  /** Optional supporting sentence. */
  hint?: string;
  /** Height of the ghost canvas (px). */
  height?: number;
  /** Optional action (e.g. a link/button) rendered under the message. */
  action?: ReactNode;
  className?: string;
}

/** Shared low-data placeholder: a ghost grid behind a short message. */
export function ChartEmpty({
  title,
  hint,
  height = 160,
  action,
  className,
}: ChartEmptyProps) {
  const rows = 4;
  const cols = 12;
  return (
    <div
      className={cn(
        "relative isolate flex items-center justify-center overflow-hidden rounded-card border border-dashed border-border/70 bg-surface-1",
        className,
      )}
      style={{ height }}
      role="img"
      aria-label={hint ? `${title}. ${hint}` : title}
    >
      {/* Ghost grid — purely decorative scaffold so the slot reads as a chart
          waiting for data rather than an empty box. */}
      <svg
        className="absolute inset-0 h-full w-full text-border"
        preserveAspectRatio="none"
        viewBox="0 0 120 40"
        aria-hidden
      >
        {Array.from({ length: rows + 1 }).map((_, i) => (
          <line
            key={`h${i}`}
            x1={0}
            x2={120}
            y1={(i / rows) * 40}
            y2={(i / rows) * 40}
            stroke="currentColor"
            strokeWidth={0.4}
            strokeOpacity={0.45}
          />
        ))}
        {Array.from({ length: cols + 1 }).map((_, i) => (
          <line
            key={`v${i}`}
            x1={(i / cols) * 120}
            x2={(i / cols) * 120}
            y1={0}
            y2={40}
            stroke="currentColor"
            strokeWidth={0.4}
            strokeOpacity={0.25}
          />
        ))}
        {/* A faint flat baseline trace so the ghost reads as "no movement yet". */}
        <line
          x1={0}
          x2={120}
          y1={30}
          y2={30}
          stroke="currentColor"
          strokeWidth={0.8}
          strokeOpacity={0.5}
          strokeDasharray="2,2"
        />
      </svg>
      <div className="relative max-w-[36ch] px-4 text-center">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        {action && <div className="mt-3 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
