import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { Badge } from "@lsat/components/ui/badge";
import { cn } from "@lsat/lib/utils";
import { qTypeLabel, trapLabel } from "@lsat/lib/labels";
import type { QType, TrapType } from "@lsat/lib/types";
import type { TrapPattern } from "@lsat/lib/types-lsat2";

/**
 * LSAT-2 — "See trap patterns" accordion.
 *
 * Surfaces the trap-similar misses the backend retrieves
 * (`trap_similar_misses_for_question`) so the student sees the recurring shape
 * they keep falling for ("you fell for this reversal on Q31, Q18"). Each row
 * lists the prior question, the trap type, the wrong choice they picked, and
 * their own note (when captured). The Q chip navigates to that question's
 * explanation.
 *
 * Accessibility: a single button toggles disclosure with `aria-expanded` and
 * `aria-controls`; the panel is `hidden` (not unmounted) when collapsed so the
 * relationship stays valid for assistive tech.
 */
export function TrapPatternsAccordion({
  patterns,
  defaultOpen = false,
  className,
}: {
  patterns: TrapPattern[];
  defaultOpen?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const buttonId = useId();

  if (!patterns.length) return null;

  return (
    <div className={cn("rounded-card border bg-card", className)}>
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-card px-4 py-3 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="text-sm font-medium">See trap patterns</span>
        <Badge variant="outline" className="text-[11px]">
          {patterns.length}
        </Badge>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="space-y-3 border-t px-4 py-3"
      >
        <p className="text-xs text-muted-foreground">
          You have fallen for similar traps before. Spotting the shared shape is
          the fastest way to stop repeating the miss.
        </p>
        <ul className="space-y-2">
          {patterns.map((p) => (
            <li
              key={p.attempt_id ?? `${p.question_id}-${p.trap_type ?? ""}`}
              className="rounded-md border bg-background/50 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/explanation/${p.question_id}`)}
                  className={cn(
                    "rounded font-medium tabular-nums text-primary underline-offset-2 hover:underline",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  title={`Open question ${p.question_id}`}
                >
                  Q{p.question_id}
                </button>
                {p.q_type ? (
                  <Badge variant="outline" className="text-[11px]">
                    {qTypeLabel(p.q_type as QType)}
                  </Badge>
                ) : null}
                {p.trap_type ? (
                  <Badge variant="secondary" className="text-[11px]">
                    {trapLabel(p.trap_type as TrapType)}
                  </Badge>
                ) : null}
                {p.chosen_answer ? (
                  <span className="text-xs text-muted-foreground">
                    you chose ({p.chosen_answer})
                  </span>
                ) : null}
              </div>
              {p.note_excerpt ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Your note: {p.note_excerpt}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
