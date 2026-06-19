/**
 * K4-2 — host-styled `Label` at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/label`: exports `Label` as a facade over
 * `@radix-ui/react-label` (same component as the LSAT primitive, so the
 * `htmlFor`/peer-disabled a11y wiring is preserved) with the same
 * `ComponentPropsWithoutRef<Root>` prop surface. Renders the HOST `.qv-label`
 * class (`src/index.css`).
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "./cn";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn("qv-label", className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
