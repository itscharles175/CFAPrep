export { StatNumber } from "./StatNumber";
export type { StatNumberProps } from "./StatNumber";

export { TypeBadge } from "./TypeBadge";
export type { TypeBadgeProps } from "./TypeBadge";

export { Sparkline } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";

export { TrendChart } from "./TrendChart";
export type { TrendChartProps, TrendDatum } from "./TrendChart";

export { HeatStrip } from "./HeatStrip";
export type { HeatStripProps, HeatCell } from "./HeatStrip";

export { GapDumbbell } from "./GapDumbbell";
export type { GapDumbbellProps, GapRow } from "./GapDumbbell";

export { MasteryMatrix } from "./MasteryMatrix";
export type { MasteryMatrixProps, MasteryRow } from "./MasteryMatrix";

export { ProgressRing } from "./ProgressRing";
export type { ProgressRingProps } from "./ProgressRing";

export { ReadinessGauge } from "./ReadinessGauge";
export type { ReadinessGaugeProps } from "./ReadinessGauge";

export { TrapSpiral } from "./TrapSpiral";
export type { TrapSpiralProps, TrapSpiralDatum } from "./TrapSpiral";

export { GapSankey } from "./GapSankey";
export type { GapSankeyProps, GapSankeyCounts } from "./GapSankey";

export { TimeRidgeline } from "./TimeRidgeline";
export type { TimeRidgelineProps, RidgelineSeries } from "./TimeRidgeline";

export { FocusTimeline } from "./FocusTimeline";
export type { FocusTimelineProps, FocusEvent } from "./FocusTimeline";

export { ContributionHeatmap } from "./ContributionHeatmap";
export type { ContributionHeatmapProps, ContributionDay } from "./ContributionHeatmap";

// R8 W3.3 — shared chart kit (tooltip / legend / scale key / reference line).
// R9 — + ChartAnnotation (milestone pins) and ChartEmpty (low-data state).
export {
  ChartTooltip,
  chartTooltipStyle,
  ChartLegend,
  ColorScaleKey,
  ReferenceLine,
  ChartAnnotation,
  ChartEmpty,
} from "./chart-kit";
export type {
  ChartTooltipProps,
  ChartLegendProps,
  LegendItem,
  ColorScaleKeyProps,
  ReferenceLineProps,
  ChartAnnotationProps,
  ChartAnnotationTone,
  ChartEmptyProps,
} from "./chart-kit";

// R9 §2 — client-side milestone derivation for the trend chart.
export { deriveTrendAnnotations } from "./trendAnnotations";
export type { TrendAnnotation } from "./trendAnnotations";
