import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@lsat/lib/utils";

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    indicatorClassName?: string;
  }
>(
  (
    {
      className,
      value,
      indicatorClassName,
      "aria-label": ariaLabel,
      "aria-valuetext": ariaValueText,
      ...props
    },
    ref,
  ) => {
    const numericValue = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;

    return (
      <ProgressPrimitive.Root
        ref={ref}
        value={value}
        aria-label={ariaLabel ?? "Progress"}
        aria-valuetext={ariaValueText ?? `${Math.round(numericValue)} percent`}
        className={cn(
          "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
          className,
        )}
        {...props}
      >
        <ProgressPrimitive.Indicator
          className={cn(
            // R11 5.1 — one progress-fill tempo (was the un-tokened `transition-all`
            // default ~150ms); animate only the transform (compositor-only).
            "h-full w-full flex-1 bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none",
            indicatorClassName,
          )}
          style={{ transform: `translateX(-${100 - numericValue}%)` }}
        />
      </ProgressPrimitive.Root>
    );
  },
);
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
