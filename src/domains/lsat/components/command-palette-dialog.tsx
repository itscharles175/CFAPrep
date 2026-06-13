/**
 * G7 — The cmdk dialog body, split into its own module so the provider can
 * lazy-load it. cmdk itself (~35 KB min+gz) is only fetched after the first
 * keystroke that opens the palette, keeping it off the critical path.
 */
import { Command } from "cmdk";
import { CornerDownLeft } from "lucide-react";
import { Kbd } from "@lsat/components/keyboard-help";
import { cn } from "@lsat/lib/utils";
import type { CommandAction } from "./command-palette";

interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grouped: [string, CommandAction[]][];
}

export default function CommandPaletteDialog({
  open,
  onOpenChange,
  grouped,
}: CommandPaletteDialogProps) {
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      // R8 — signature frosted surface with a verdict edge-glow. The dialog
      // gets a scale/fade enter via Radix's data-state (the global
      // prefers-reduced-motion net neutralizes it for users who ask).
      // Visual styles live on className (the inner Command surface); Radix's
      // Dialog.Content owns the fixed positioning via contentClassName.
      className={cn(
        "glass glow-verdict w-full max-w-lg",
        "overflow-hidden rounded-card border text-popover-foreground shadow-e4 duration-150",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
      )}
      overlayClassName="fixed inset-0 z-50 bg-background/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      contentClassName="fixed left-1/2 top-[18%] z-50 w-full max-w-lg -translate-x-1/2"
    >
      <Command.Input
        placeholder="Type a command or search…"
        className="w-full border-b bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="scroll-thin max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">
          No results found.
        </Command.Empty>
        {grouped.map(([group, items]) => (
          <Command.Group
            key={group}
            heading={
              <span className="flex items-center justify-between">
                <span>{group}</span>
                <span className="type-numeric text-[10px] font-normal tabular-nums text-muted-foreground/60">
                  {items.length}
                </span>
              </span>
            }
            className="[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.09em] [&_[cmdk-group-heading]]:text-muted-foreground [&:not(:first-child)]:mt-1"
          >
            {items.map((a) => (
              <Command.Item
                key={a.id}
                value={`${a.label} ${(a.keywords ?? []).join(" ")}`}
                onSelect={() => {
                  onOpenChange(false);
                  a.perform();
                }}
                className={cn(
                  "group relative flex cursor-pointer items-center gap-2.5 rounded-md py-2 pl-4 pr-2 text-sm",
                  "transition-colors duration-100",
                  // selected-row accent bar (verdict) — drawn via a left inset pseudo-element
                  "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-verdict-500 before:opacity-0 before:transition-opacity",
                  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:before:opacity-100",
                )}
              >
                {a.icon && (
                  <span className="text-muted-foreground transition-colors group-data-[selected=true]:text-accent-foreground">
                    {a.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{a.label}</span>
                {a.shortcut && a.shortcut.length > 0 && (
                  <span className="flex flex-shrink-0 items-center gap-1">
                    {a.shortcut.map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      {/* Footer hint row — quietly teaches the keyboard model. */}
      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>to navigate</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft className="h-3 w-3" aria-hidden />
          </Kbd>
          <span>to select</span>
          <span className="px-1 text-muted-foreground/40">·</span>
          <Kbd>Esc</Kbd>
          <span>to close</span>
        </span>
      </div>
    </Command.Dialog>
  );
}
