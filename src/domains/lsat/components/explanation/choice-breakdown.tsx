import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@lsat/lib/utils";
import { trapLabel } from "@lsat/lib/labels";
import type { Choice, TrapType } from "@lsat/lib/types";

/** R4-D8 — collapsible accordion per answer choice. */
export function ChoiceBreakdown({
  choices,
  correctAnswer,
  chosen,
  perChoiceNote,
  spotlight,
  onSpotlight,
}: {
  choices: Choice[];
  correctAnswer?: string;
  chosen: string;
  perChoiceNote?: Record<string, string>;
  spotlight: string | null;
  onSpotlight: (label: string | null) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (chosen && chosen !== "—") init[chosen] = true;
    return init;
  });

  return (
    <div className="space-y-2">
      {choices.map((c) => {
        const isCorrect = c.is_correct || c.label === correctAnswer;
        const isChosen = c.label === chosen;
        const isOpen = !!open[c.label];
        const note = perChoiceNote?.[c.label];

        return (
          <div
            key={c.id}
            className={cn(
              "overflow-hidden rounded-md border transition-colors",
              isCorrect && "border-success/40",
              isChosen && !isCorrect && "border-destructive/40",
              spotlight === c.label && "ring-2 ring-info",
            )}
          >
            <button
              type="button"
              className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-accent/50"
              onClick={() =>
                setOpen((o) => ({ ...o, [c.label]: !o[c.label] }))
              }
              aria-expanded={isOpen}
              onMouseEnter={() => onSpotlight(c.label)}
              onMouseLeave={() => onSpotlight(null)}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  isCorrect && "border-success bg-success text-success-foreground",
                  isChosen &&
                    !isCorrect &&
                    "border-destructive bg-destructive text-destructive-foreground",
                )}
              >
                {c.label}
              </span>
              <span className="flex-1 line-clamp-1">{c.text}</span>
              {c.trap_type && c.trap_type !== "none" && (
                <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                  {trapLabel(c.trap_type as TrapType)}
                </span>
              )}
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-180",
                )}
              />
            </button>
            {isOpen && (
              <div className="border-t px-3 pb-3 pt-2 text-sm text-muted-foreground">
                <p>{c.text}</p>
                {note && <p className="mt-2 text-foreground">{note}</p>}
                {isCorrect && (
                  <p className="mt-2 text-success text-xs font-medium">
                    Correct answer
                  </p>
                )}
                {isChosen && !isCorrect && (
                  <p className="mt-2 text-destructive text-xs font-medium">
                    Your timed answer
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
