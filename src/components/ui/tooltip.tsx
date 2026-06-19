/**
 * K4-2 — host-styled `Tooltip` family (cheap Radix-backed extra).
 *
 * Drop-in for `@lsat/components/ui/tooltip`: same exports (`Tooltip`,
 * `TooltipTrigger`, `TooltipContent`, `TooltipProvider`) and prop surfaces.
 * Facade over `@radix-ui/react-tooltip` — hover/focus open timing, dismissal,
 * and `aria-describedby` wiring come from Radix; only the content class changes
 * to the host `.qv-tooltip-content` vocabulary (`src/index.css`). Keeps the LSAT
 * primitive's `sideOffset={4}` default.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "./cn";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn("qv-tooltip-content", className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
