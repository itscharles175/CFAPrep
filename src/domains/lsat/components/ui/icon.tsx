import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * R8 (docs/18 W1.9): a single icon identity — one stroke weight and a small set
 * of sizes — so new surfaces stop hand-rolling ~292 ad-hoc `h-N w-N` sizings.
 * Opt-in: `<Icon as={Search} size="sm" />`.
 */
const SIZE: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

export function Icon({
  as: Glyph,
  size = "sm",
  className,
  ...props
}: {
  as: LucideIcon;
  size?: "xs" | "sm" | "md" | "lg";
} & React.SVGProps<SVGSVGElement>) {
  return (
    <Glyph
      className={cn(SIZE[size], "shrink-0", className)}
      strokeWidth={1.75}
      aria-hidden="true"
      {...props}
    />
  );
}
