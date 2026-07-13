import { useMemo } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Stroke color (defaults to the brand primary). */
  color?: string;
  strokeWidth?: number;
  /** Fill area under the line at low opacity. */
  fill?: boolean;
  className?: string;
}

/** Tiny visx line sparkline for KPI rows. */
export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = "hsl(var(--primary))",
  strokeWidth = 1.5,
  fill = false,
  className,
}: SparklineProps) {
  const pad = 2;
  const { x, y, areaPath } = useMemo(() => {
    const xs = scaleLinear<number>({
      domain: [0, Math.max(1, data.length - 1)],
      range: [pad, width - pad],
    });
    const min = Math.min(...data);
    const max = Math.max(...data);
    const ys = scaleLinear<number>({
      domain: [min === max ? min - 1 : min, min === max ? max + 1 : max],
      range: [height - pad, pad],
    });
    let area = "";
    if (fill && data.length) {
      const pts = data.map((d, i) => `${xs(i)},${ys(d)}`).join(" L ");
      area = `M ${xs(0)},${height - pad} L ${pts} L ${xs(data.length - 1)},${height - pad} Z`;
    }
    return { x: xs, y: ys, areaPath: area };
  }, [data, width, height, fill]);

  if (!data.length) return null;

  return (
    <svg
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Sparkline trend"
    >
      {fill && <path d={areaPath} fill={color} opacity={0.12} />}
      <LinePath<number>
        data={data}
        x={(_, i) => x(i) ?? 0}
        y={(d) => y(d) ?? 0}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        curve={curveMonotoneX}
      />
    </svg>
  );
}
