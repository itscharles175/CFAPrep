/**
 * K4-2 — host-styled `Tabs` family (cheap Radix-backed extra).
 *
 * Drop-in for `@lsat/components/ui/tabs`: same exports (`Tabs`, `TabsList`,
 * `TabsTrigger`, `TabsContent`) and Radix-derived prop surfaces. Facade over
 * `@radix-ui/react-tabs` — roving-tabindex keyboard nav (arrow keys, Home/End),
 * `aria-selected`, and content association come from Radix. The host version
 * renders the `.qv-tabs-*` vocabulary (`src/index.css`, built on the existing
 * `.segmented-tab` active-pill look) and intentionally drops the LSAT
 * `motion`-driven sliding-pill indicator: the host applies the active background
 * directly via the `data-[state=active]` CSS rule, so there's no extra runtime
 * dependency and the prop surface is unchanged.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "./cn";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("qv-tabs-list", className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={cn("qv-tabs-trigger", className)} {...props} />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("qv-tabs-content", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
