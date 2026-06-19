/**
 * K4-2 — host-styled `Input` at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/input`: exports `Input` + the same
 * `InputProps` (= `React.InputHTMLAttributes<HTMLInputElement>`), forwards the
 * ref, and renders the HOST `.qv-input` class (`src/index.css`), which inherits
 * the host's element-level input focus ring (accent border + `--ring` glow).
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import { cn } from "./cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn("qv-input", className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
