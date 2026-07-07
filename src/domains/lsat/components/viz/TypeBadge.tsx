import { cn } from "@lsat/lib/utils";
import { qTypeLabel } from "@lsat/lib/labels";
import {
  typeColor,
  typeColorNeedsDarkText,
  typeFamily,
  type TypeFamily,
} from "@lsat/lib/labels";
import type { QType } from "@lsat/lib/types";

export interface TypeBadgeProps {
  qType: QType;
  /** Solid filled pill vs tinted/outline. */
  variant?: "solid" | "soft";
  /** Show a leading color dot instead of a full pill (for dense rows). */
  dot?: boolean;
  className?: string;
  label?: string;
}

const TYPE_COLOR_VAR: Record<TypeFamily, string> = {
  Assumption: "--tcolor-assumption",
  StrengthenWeaken: "--tcolor-strengthen-weaken",
  FlawStructure: "--tcolor-flaw-structure",
  Inference: "--tcolor-inference",
  Principle: "--tcolor-principle",
  Parallel: "--tcolor-parallel",
  Paradox: "--tcolor-paradox",
  RC: "--tcolor-rc",
};

/** Question-type pill using the stable Okabe–Ito `typeColor`. */
export function TypeBadge({
  qType,
  variant = "soft",
  dot = false,
  className,
  label,
}: TypeBadgeProps) {
  const fallbackColor = typeColor(qType);
  const color = `var(${TYPE_COLOR_VAR[typeFamily(qType)]}, ${fallbackColor})`;
  const text = label ?? qTypeLabel(qType);

  if (dot) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        {text}
      </span>
    );
  }

  if (variant === "solid") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-semibold",
          className,
        )}
        style={{
          backgroundColor: color,
          color: typeColorNeedsDarkText(qType) ? "#111827" : "#ffffff",
        }}
      >
        {text}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
        color: "hsl(var(--foreground))",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 33%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {text}
    </span>
  );
}
