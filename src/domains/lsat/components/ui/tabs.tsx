import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { m, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * R12 (docs/21 deferred): the active-tab pill is a single sliding indicator
 * rather than a per-trigger background, so selection "magic-moves" across the
 * list — mirroring the nav active-bar in app-shell (same spring).
 *
 * Implemented by measuring the active trigger's box and animating one
 * absolutely-positioned span to it, rather than Framer `layoutId`. That keeps it
 * compatible with every existing consumer (controlled or uncontrolled) and with
 * flex / flex-wrap / grid lists, without needing access to Radix's value. The
 * indicator is aria-hidden and click-through; reduced motion snaps instantly.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();
  const [rect, setRect] = React.useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    ready: false,
  });

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  React.useLayoutEffect(() => {
    const list = innerRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]');
      if (!active) {
        setRect((r) => (r.ready ? { ...r, ready: false } : r));
        return;
      }
      setRect({
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
        ready: true,
      });
    };
    measure();
    // Radix toggles `data-state` on the triggers when selection changes.
    const mo = new MutationObserver(measure);
    mo.observe(list, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-state"],
    });
    // Re-measure on resize/reflow (e.g. flex-wrap row changes, font load).
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(list);
    }
    // If the list mounts hidden (inside a closed Sheet / collapsed section) the
    // trigger boxes are 0×0, so the first measure mis-places the pill. Re-measure
    // each time the list becomes visible (cleaned up in the effect's return).
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) measure();
      });
      io.observe(list);
    }
    // Web fonts can change trigger widths after the initial measure; re-measure
    // once they're ready. Guarded so a late resolve after unmount is ignored.
    let cancelled = false;
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      mo.disconnect();
      ro?.disconnect();
      io?.disconnect();
    };
  }, []);

  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        "relative inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    >
      {rect.ready && (
        <m.span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-0 rounded-sm bg-background shadow-e1"
          initial={false}
          animate={{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // `relative z-10` keeps the trigger (and its focus ring) above the sliding
      // pill; the pill — not the trigger — now paints the active background.
      "relative z-10 inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
