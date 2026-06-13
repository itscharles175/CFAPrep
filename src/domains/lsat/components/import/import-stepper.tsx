import { Check } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * R8 (docs/18) — the Import wizard's progress spine. The three-step flow
 * (Upload → Verify → Done) used to be invisible: each step was a bare page with
 * no sense of "where am I / what's left". This renders a calm, token-driven
 * stepper shared across all three step views.
 */

export type ImportStep = "upload" | "verify" | "done";

const STEPS: { key: ImportStep; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "verify", label: "Verify" },
  { key: "done", label: "Done" },
];

export function ImportStepper({
  current,
  className,
}: {
  current: ImportStep;
  className?: string;
}) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol
      className={cn("flex items-center gap-2", className)}
      aria-label="Import progress"
    >
      {STEPS.map((s, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className="flex items-center gap-2"
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
                  done && "border-transparent bg-primary text-primary-foreground",
                  active &&
                    "border-primary bg-primary-subtle text-primary glow-verdict",
                  !done && !active && "border-border bg-surface-1 text-muted-foreground",
                )}
              >
                {done ? <Icon as={Check} size="xs" /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-sm",
                  active ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1 rounded-full transition-colors",
                  done ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
