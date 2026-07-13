import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@lsat/lib/utils";

const alertVariants = cva(
  // R11 2.3 — status tints use the `*-subtle` tokens (was raw `bg-*/10`, which
  // didn't match `--subtle-alpha` and skipped the high-contrast hardening).
  "relative w-full rounded-card border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        info: "border-info/30 bg-info-subtle text-foreground [&>svg]:text-info",
        success:
          "border-success/30 bg-success-subtle text-foreground [&>svg]:text-success",
        warning:
          "border-warning/40 bg-warning-subtle text-foreground [&>svg]:text-warning",
        destructive:
          "border-destructive/40 bg-destructive-subtle text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, children, ...props }, ref) => (
  // Render `children` explicitly (rather than only spreading props) so the
  // heading statically carries content — satisfies jsx-a11y/heading-has-content.
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  >
    {children}
  </h5>
));
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
