/**
 * K4-2 — host-styled `Badge` at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/badge`: exports `Badge` + `badgeVariants`
 * with the same `variant` keys (default/secondary/destructive/success/warning/
 * outline) so `VariantProps<typeof badgeVariants>` and `BadgeProps` are
 * identical. Renders the HOST `.badge` / `.qv-badge-*` vocabulary
 * (`src/index.css`) instead of the LSAT Tailwind classes.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const badgeVariants = cva("badge qv-badge", {
  variants: {
    variant: {
      default: "qv-badge-default",
      secondary: "qv-badge-secondary",
      destructive: "qv-badge-destructive",
      success: "qv-badge-success",
      warning: "qv-badge-warning",
      outline: "qv-badge-outline",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
