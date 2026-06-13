import { Keyboard } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * R8 (docs/18) — a visible keyboard-shortcut affordance for the review surfaces
 * (Quarantine triage, Tag review). Replaces the buried "Shortcuts: A approve ·
 * D dismiss" sentence with a calm, scannable bar of real <kbd> keys so the
 * power-user path is discoverable instead of folklore.
 */
export function ShortcutBar({
  shortcuts,
  className,
}: {
  shortcuts: { keys: string[]; label: string }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border bg-surface-1 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Icon as={Keyboard} size="sm" />
        Shortcuts
      </span>
      {shortcuts.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          {s.keys.map((k) => (
            <kbd
              key={k}
              className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-2xs font-medium text-foreground"
            >
              {k}
            </kbd>
          ))}
          <span>{s.label}</span>
        </span>
      ))}
    </div>
  );
}
