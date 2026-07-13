/**
 * K4-2 — host-styled `Dialog` family at the LSAT primitive's module names +
 * prop surfaces.
 *
 * Drop-in for `@lsat/components/ui/dialog`: same exports (`Dialog`,
 * `DialogPortal`, `DialogOverlay`, `DialogTrigger`, `DialogClose`,
 * `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`,
 * `DialogDescription`) and the same prop surfaces. This is a host-styled FACADE
 * OVER `@radix-ui/react-dialog` — the focus trap, `aria-modal`, Escape-to-close,
 * scroll lock, and return-focus a11y all come from Radix; only the class names
 * change to the host `.qv-dialog-*` vocabulary (`src/index.css`). `DialogContent`
 * keeps the LSAT primitive's `aria-describedby` defaulting and built-in close
 * button.
 *
 * NET-NEW: nothing imports this yet.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./cn";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("qv-dialog-overlay", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, "aria-describedby": ariaDescribedBy, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // Default aria-describedby to undefined when none is given to avoid the
      // Radix "Missing Description" warning; dialogs that DO pass one keep it.
      aria-describedby={ariaDescribedBy ?? undefined}
      className={cn("qv-dialog-content", className)}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="qv-dialog-close">
        <X className="qv-dialog-close-icon" aria-hidden="true" />
        <span className="qv-sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("qv-dialog-header", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("qv-dialog-footer", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("qv-dialog-title", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("qv-dialog-description", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
