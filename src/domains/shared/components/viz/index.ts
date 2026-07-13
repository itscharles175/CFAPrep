/**
 * ANL-5 — shared, host-styled viz barrel.
 *
 * The LSAT domain's @visx viz primitives (TrendChart / HeatStrip / StatNumber /
 * ReadinessGauge) promoted into a host barrel restyled onto the host design
 * tokens, plus a small chart-kit compat layer (visx-based wrappers that replace
 * the host's bare `recharts` usage in src/pages/Analytics.jsx). Self-contained:
 * depends only on host packages, so host strict tsc type-checks it without the
 * `@lsat/*` aliases.
 */

export { StatNumber } from './StatNumber';
export type { StatNumberProps } from './StatNumber';

export { TrendChart } from './TrendChart';
export type { TrendChartProps, TrendDatum } from './TrendChart';

export { HeatStrip } from './HeatStrip';
export type { HeatStripProps, HeatCell } from './HeatStrip';

export { ReadinessGauge } from './ReadinessGauge';
export type { ReadinessGaugeProps, ReadinessRing } from './ReadinessGauge';

// Shared chart kit + recharts-compat visx wrappers used by Analytics.jsx.
export {
  cn,
  VIZ_TOKENS,
  ChartTooltip,
  chartTooltipStyle,
  ChartLegend,
  ReferenceLine,
  LineTrend,
  BandTrend,
  BarSeriesChart,
  CalibrationScatter,
} from './chart-kit';
export type {
  ChartTooltipProps,
  ChartLegendProps,
  LegendItem,
  ReferenceLineProps,
  LineSeries,
  LineTrendProps,
  BandTrendProps,
  BarSeries,
  BarSeriesChartProps,
  ScatterPoint,
  ScatterSeries,
  CalibrationScatterProps,
} from './chart-kit';
