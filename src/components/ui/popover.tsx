/**
 * K4-2 — host-styled `Popover` family (cheap Radix-backed extra).
 *
 * Drop-in for `@lsat/components/ui/popover`: same exports (`Popover`,
 * `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`) and prop surfaces. Facade
 * over `@radix-ui/react-popover` — positioning, focus management, and dismiss
 * a11y come from Radix; only the content class changes to the host
 * `.qv-popover-content` vocabulary (`src/index.css`). Keeps the LSAT primitive's
 * `align="center"` / `sideOffset={4}` defaults.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "./cn";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn("qv-popover-content", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
