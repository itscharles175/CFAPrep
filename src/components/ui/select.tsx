/**
 * K4-2 — host-styled `Select` family at the LSAT primitive's module names +
 * prop surfaces.
 *
 * Drop-in for `@lsat/components/ui/select`: same exports (`Select`,
 * `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectItem`)
 * and the same Radix-derived prop surfaces. This is a host-styled FACADE OVER
 * `@radix-ui/react-select` — the keyboard navigation, typeahead, and
 * focus-management a11y come straight from Radix; only the class names change to
 * the host `.qv-select-*` vocabulary (`src/index.css`). The trigger/content/item
 * structure (portal, scroll buttons, item-indicator check) is preserved so
 * behaviour matches the LSAT primitive exactly.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "./cn";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn("qv-select-trigger", className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="qv-select-trigger-icon" aria-hidden="true" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "qv-select-content",
        position === "popper" && "qv-select-content-popper",
        className,
      )}
      position={position}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="qv-select-scroll-button">
        <ChevronUp className="qv-select-trigger-icon" aria-hidden="true" />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport
        className={cn(
          "qv-select-viewport",
          position === "popper" && "qv-select-viewport-popper",
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="qv-select-scroll-button">
        <ChevronDown className="qv-select-trigger-icon" aria-hidden="true" />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn("qv-select-item", className)} {...props}>
    <span className="qv-select-item-indicator">
      <SelectPrimitive.ItemIndicator>
        <Check className="qv-select-item-check" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
};
