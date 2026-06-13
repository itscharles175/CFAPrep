import * as React from "react";
import { cn } from "@lsat/lib/utils";

/**
 * R8 (docs/18 W1.9): the ScrollArea was a no-op `overflow-auto` div with raw
 * native scrollbars. It now applies the themed thin-scrollbar treatment
 * (`scroll-thin`, defined in index.css) so scrollable regions read as authored
 * chrome in every theme, without pulling in a Radix scroll-area dependency.
 */
export function ScrollArea({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("scroll-thin relative overflow-auto", className)} {...props}>
      {children}
    </div>
  );
}
