import { cn } from "@/lib/utils";
import { qTypeLabel } from "@/lib/labels";
import { typeColor, typeColorNeedsDarkText } from "@/lib/labels";
import type { QType } from "@/lib/types";

export interface TypeBadgeProps {
  qType: QType;
  /** Solid filled pill vs tinted/outline. */
  variant?: "solid" | "soft";
  /** Show a leading color dot instead of a full pill (for dense rows). */
  dot?: boolean;
  className?: string;
  label?: string;
}

/** Question-type pill using the stable Okabe–Ito `typeColor`. */
export function TypeBadge({
  qType,
  variant = "soft",
  dot = false,
  className,
  label,
}: TypeBadgeProps) {
  const color = typeColor(qType);
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
        backgroundColor: `${color}22`,
        color,
        boxShadow: `inset 0 0 0 1px ${color}55`,
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
