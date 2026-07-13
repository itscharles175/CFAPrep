import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@lsat/lib/utils";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(
  (
    {
      className,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledby,
      ...props
    },
    ref,
  ) => {
    const thumbs = props.value ?? props.defaultValue ?? [0];
    return (
      <SliderPrimitive.Root
        ref={ref}
        className={cn(
          "relative flex w-full touch-none select-none items-center",
          className,
        )}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
          <SliderPrimitive.Range className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>
        {thumbs.map((_, i) => (
          <SliderPrimitive.Thumb
            key={i}
            // Radix's Thumb is the focusable role="slider" element, so the
            // accessible name must live here, not on Root. Forward a single
            // label to a single-thumb slider (the common case); range sliders
            // with multiple thumbs should instead be labelled per-thumb.
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledby}
            className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow-e1 ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
