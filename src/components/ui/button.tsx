/**
 * K4-2 — host-styled `Button` at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/button` (or a relative `../ui/button`): it
 * exports the same `Button` + `buttonVariants` and accepts the same props
 * (`variant`, `size`, `asChild`, `loading`) and the same `VariantProps`-derived
 * `ButtonProps`. It renders the HOST design system's `.btn` vocabulary
 * (`src/index.css`) instead of the LSAT Tailwind classes that depend on the
 * LSAT `body` rule, so swapping the import reskins a screen to the host look
 * with no call-site churn.
 *
 * NET-NEW: nothing imports this yet — it is the target vocabulary for a later
 * reskin pass.
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

// Host `.btn` class composition. The variant/size KEYS mirror the LSAT button
// exactly (default/destructive/outline/secondary/ghost/link · default/sm/lg/icon)
// so `VariantProps<typeof buttonVariants>` is identical; only the emitted class
// names differ (host `.btn-*`, defined in `src/index.css`'s `@layer components`).
const buttonVariants = cva("btn qv-btn", {
  variants: {
    variant: {
      default: "btn-primary",
      destructive: "btn-danger",
      outline: "btn-secondary qv-btn-outline",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      link: "btn-link",
    },
    size: {
      default: "",
      sm: "btn-sm",
      lg: "btn-lg",
      icon: "btn-icon",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Show an inline spinner and disable the button while pending (LSAT parity). */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    // Slot requires a single child, so the spinner is only injected for a real
    // <button>; an asChild button still disables while loading.
    const content =
      loading && !asChild ? (
        <>
          <Loader2 className="qv-spin" aria-hidden="true" />
          {children}
        </>
      ) : (
        children
      );
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {content}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
