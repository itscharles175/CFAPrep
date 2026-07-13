/**
 * K4-2 — host-styled `Card` family at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/card`: same exports
 * (`Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`)
 * and the same extended props — `Card` takes `interactive?`, `CardTitle` takes
 * `voice?: "sans" | "display"`. Renders the HOST `.qv-card*` vocabulary (defined
 * in `src/index.css`'s `@layer components`, built on the host `--bg-card` /
 * `--card-pad` / elevation tokens) rather than the LSAT Tailwind classes.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import { cn } from "./cn";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }
>(({ className, interactive, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "qv-card",
      // Parity with the LSAT card's opt-in hover-lift affordance for clickable
      // cards (no false affordance on static cards).
      interactive && "qv-card-interactive",
      className,
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("qv-card-header", className)} {...props} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { voice?: "sans" | "display" }
>(({ className, voice = "sans", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "qv-card-title",
      // `voice="display"` opts into the serif editorial voice (the host
      // `.type-display` cast); the sans default stays dense.
      voice === "display" && "qv-card-title-display type-display",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("qv-card-description", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("qv-card-content", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("qv-card-footer", className)} {...props} />
));
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
