import { memo } from "react";
import { Check, X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { cn } from "@lsat/lib/utils";
import { duration, easing } from "@lsat/lib/motion";
import type { ChoiceSize, ChoiceSpacing } from "@lsat/lib/prefs";
import type { Choice, TrapType } from "@lsat/lib/types";
import { trapLabel } from "@lsat/lib/labels";

const LETTER_SIZE: Record<ChoiceSize, string> = {
  sm: "h-5 w-5 text-[10px]",
  md: "h-6 w-6 text-xs",
  lg: "h-8 w-8 text-sm",
};

const CHOICE_SPACING: Record<ChoiceSpacing, string> = {
  tight: "space-y-1",
  normal: "space-y-2",
  relaxed: "space-y-4",
};

export interface ChoiceListProps {
  choices: Choice[];
  selected: string | null;
  eliminated: Set<string>;
  onSelect: (label: string) => void;
  onToggleEliminate: (label: string) => void;
  // Review mode reveals correctness.
  reveal?: boolean;
  correctAnswer?: string;
  perChoiceNote?: Record<string, string>;
  /** Optional: highlight a specific choice label (e.g. AI explanation citation). */
  spotlight?: string | null;
  choiceSize?: ChoiceSize;
  choiceSpacing?: ChoiceSpacing;
}

function ChoiceListImpl({
  choices,
  selected,
  eliminated,
  onSelect,
  onToggleEliminate,
  reveal = false,
  correctAnswer,
  perChoiceNote,
  spotlight = null,
  choiceSize = "md",
  choiceSpacing = "normal",
}: ChoiceListProps) {
  const reduceMotion = useReducedMotion();

  return (
    <ul
      className={CHOICE_SPACING[choiceSpacing]}
      role="radiogroup"
      aria-label="Answer choices"
    >
      {choices.map((c) => {
        const isSelected = selected === c.label;
        const isElim = eliminated.has(c.label);
        const isCorrect = reveal && (c.is_correct || c.label === correctAnswer);
        const isWrongPick = reveal && isSelected && !isCorrect;
        const isSpot = spotlight === c.label;

        return (
          <li key={c.id}>
            <div
              className={cn(
                "relative flex items-stretch overflow-hidden rounded-md border transition-[border-color,background-color,box-shadow,opacity]",
                // Selected (test mode) — unmistakable ring + tint.
                isSelected && !reveal && "border-primary bg-primary/5 ring-2 ring-primary",
                isCorrect && "border-success bg-success/10",
                isWrongPick && "border-destructive bg-destructive/10",
                // Eliminated — muted + dashed, clearly "out".
                isElim && !reveal && "border-dashed border-muted-foreground/40 opacity-60",
                // Spotlight (AI citation) — temporary emphasis.
                isSpot && !isSelected && !reveal && "ring-2 ring-info",
              )}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                // a11y #13 — name the radio by BOTH the letter and the choice
                // text (a plain `aria-label="Choice A"` would hide the text from
                // screen readers). The eliminated status node is appended when
                // present so SRs still announce "eliminated".
                aria-labelledby={cn(
                  `choice-letter-${c.id}`,
                  `choice-text-${c.id}`,
                  isElim && `choice-elim-${c.id}`,
                )}
                onClick={() => onSelect(c.label)}
                className={cn(
                  "flex flex-1 items-start gap-3 p-3 text-left text-sm",
                  "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="relative flex shrink-0 items-center justify-center">
                  {/* R9 "answer committed" micro-moment (docs/19). When a choice is
                      selected DURING the timed section, the letter chip plays one
                      calm NEUTRAL ink-set: a brief settle + a single brand-violet
                      ripple. It is deliberately correctness-neutral — it reuses the
                      `primary` (UI accent) tokens only, never `success`/`destructive`
                      — so committing reveals nothing about whether the pick is right
                      (Test-Mode integrity, docs/06 §4.5). It is gated on `!reveal`,
                      so in review the static correct/wrong chip styling takes over
                      and no ripple plays. Reduced-motion → no settle, no ripple. */}
                  {isSelected && !reveal && !reduceMotion && (
                    <m.span
                      key={c.label}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/60"
                      initial={{ opacity: 0.7, scale: 1 }}
                      animate={{ opacity: 0, scale: 1.9 }}
                      transition={{ duration: duration.celebrate, ease: easing.standard }}
                    />
                  )}
                  <m.span
                    // Re-key on (de)selection so the settle replays each commit.
                    key={isSelected && !reveal ? "sel" : "idle"}
                    id={`choice-letter-${c.id}`}
                    initial={
                      isSelected && !reveal && !reduceMotion ? { scale: 0.82 } : false
                    }
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 520, damping: 24 }}
                    className={cn(
                      "flex items-center justify-center rounded-full border font-semibold transition-colors",
                      LETTER_SIZE[choiceSize],
                      isSelected && !reveal && "border-primary bg-primary text-primary-foreground",
                      isElim && !reveal && "border-muted-foreground/40 text-muted-foreground",
                      isCorrect && "border-success bg-success text-success-foreground",
                      isWrongPick && "border-destructive bg-destructive text-destructive-foreground",
                    )}
                  >
                    {c.label}
                  </m.span>
                </span>
                <span className="relative flex-1">
                  <span id={`choice-text-${c.id}`} className="relative inline">
                    {c.text}
                    {/* Animated strike-through line for eliminated choices. */}
                    {!reveal && (
                      <AnimatePresence>
                        {isElim && (
                          <m.span
                            aria-hidden
                            className="pointer-events-none absolute left-0 top-1/2 h-px bg-muted-foreground/70"
                            initial={reduceMotion ? { width: "100%" } : { width: 0 }}
                            animate={{ width: "100%" }}
                            exit={reduceMotion ? { width: "100%" } : { width: 0 }}
                            transition={{ duration: reduceMotion ? 0 : duration.base, ease: easing.standard }}
                          />
                        )}
                      </AnimatePresence>
                    )}
                  </span>
                  {/* a11y #13 — eliminated status, referenced by the radio's
                      aria-labelledby so SRs announce it as part of the name. */}
                  {isElim && (
                    <span id={`choice-elim-${c.id}`} className="sr-only">
                      , eliminated
                    </span>
                  )}
                  {reveal && c.trap_type && c.trap_type !== "none" && (
                    <span className="ml-2 inline-block rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                      Trap: {trapLabel(c.trap_type as TrapType)}
                    </span>
                  )}
                  {reveal && perChoiceNote?.[c.label] && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {perChoiceNote[c.label]}
                    </span>
                  )}
                </span>
                {reveal && isCorrect && (
                  <Check className="h-4 w-4 shrink-0 text-success" />
                )}
                {reveal && isWrongPick && (
                  <X className="h-4 w-4 shrink-0 text-destructive" />
                )}
              </button>
              {!reveal && (
                <button
                  type="button"
                  title="Eliminate (E)"
                  aria-label={`Eliminate choice ${c.label}`}
                  aria-pressed={isElim}
                  onClick={() => onToggleEliminate(c.label)}
                  className={cn(
                    "flex w-10 shrink-0 items-center justify-center border-l text-muted-foreground transition-colors hover:bg-accent",
                    isElim && "bg-destructive/10 text-destructive",
                  )}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A2.2 — memoized so a parent re-render that does not change the choices /
 * selection / eliminations (e.g. flag toggle, note edits, reading-control
 * changes) skips re-rendering the whole choice list. Props from SectionRunner
 * are referentially stable: `choices` is per-question, `eliminated` is the same
 * Set until a (de)selection, and the callbacks are `useCallback`-stable.
 */
export const ChoiceList = memo(ChoiceListImpl);
