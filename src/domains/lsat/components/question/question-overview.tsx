import { useEffect, useRef } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { CheckCheck, Flag, Scissors, X } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { cn, formatClock, formatMs } from "@lsat/lib/utils";
import { duration, scaleIn } from "@lsat/lib/motion";
import { qTypeLabel, typeColor } from "@lsat/lib/labels";
import type { NavItem } from "@lsat/components/question/navigator-strip";

/**
 * R9 (docs/19 "a summonable question overview map").
 *
 * A calm, summonable panorama of every question in the section — a designed
 * grid distinct from the cramped footer strip. Each tile shows only PROGRESS
 * state: answered / flagged / has-eliminations / time-on-question, plus a small
 * type-color dot. Tapping a tile jumps to it.
 *
 * TEST-MODE INTEGRITY (docs/06 §4.5): this overlay can be summoned WHILE A
 * SECTION IS TIMED, so it must never reveal correctness. It is fed only a
 * `NavItem[]` (answered/flagged/hasEliminations/timeMs/qType/previewText) — there
 * is deliberately no `is_correct`, `correctAnswer`, or trap data in scope here,
 * so there is no way for it to leak a verdict. The legend and tiles speak purely
 * about the user's own marks and pacing.
 */
export function QuestionOverview({
  open,
  onClose,
  current,
  items,
  onJump,
  elapsedSec,
  totalSec,
  timed = true,
}: {
  open: boolean;
  onClose: () => void;
  current: number;
  items: NavItem[];
  onJump: (index: number) => void;
  elapsedSec?: number;
  totalSec?: number;
  timed?: boolean;
}) {
  const reduce = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // R9 a11y — this is a true modal while the timed section may be running:
  // move focus into it, keep Tab inside its controls, and restore the summon
  // button when it closes. The scrim is deliberately removed from the tab
  // order so aria-modal describes the same focus boundary users experience.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first || dialogRef.current)?.focus?.({ preventScroll: true });
    }, 0);

    function handleFocusKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    window.addEventListener('keydown', handleFocusKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleFocusKeyDown);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  const answered = items.filter((it) => it.answered).length;
  const flagged = items.filter((it) => it.flagged).length;

  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : duration.base }}
        >
          {/* Scrim. */}
          <button
            type="button"
            aria-label="Close overview"
            tabIndex={-1}
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={onClose}
          />

          <m.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Question overview"
            tabIndex={-1}
            className="glass relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-card border shadow-e4"
            // Modal-enter unified on the shared `scaleIn` variant (R11 5.1).
            variants={scaleIn}
            initial={reduce ? false : "hidden"}
            animate="show"
            exit="exit"
          >
            {/* Header — pacing summary (no correctness). */}
            <div className="flex items-start justify-between gap-3 border-b p-5">
              <div className="space-y-1">
                <p className="type-overline text-muted-foreground">Overview</p>
                <h2 className="type-display text-xl leading-tight">All questions</h2>
                <p className="text-sm text-muted-foreground">
                  <span className="type-numeric text-foreground">{answered}</span> of{" "}
                  <span className="type-numeric">{items.length}</span> answered
                  {flagged > 0 && (
                    <>
                      {" · "}
                      <span className="type-numeric text-warning">{flagged}</span> flagged
                    </>
                  )}
                  {timed && totalSec != null && elapsedSec != null && (
                    <>
                      {" · "}
                      <span className="type-numeric">{formatClock(totalSec - elapsedSec)}</span> left
                    </>
                  )}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Close overview" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* The grid. */}
            <div className="scroll-thin grid grid-cols-5 gap-2 overflow-y-auto p-5 sm:grid-cols-8">
              {items.map((it, i) => {
                const isCurrent = i === current;
                const dot = it.qType ? typeColor(it.qType) : undefined;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onJump(i)}
                    aria-label={`Question ${i + 1}${it.flagged ? ", flagged" : ""}${
                      it.answered ? ", answered" : ", unanswered"
                    }${it.hasEliminations ? ", has eliminations" : ""}${
                      isCurrent ? ", current" : ""
                    }`}
                    aria-current={isCurrent ? "true" : undefined}
                    title={it.qType ? qTypeLabel(it.qType) : undefined}
                    className={cn(
                      "group relative flex aspect-square flex-col items-center justify-center rounded-card border text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isCurrent && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                      it.flagged
                        ? "border-warning/50 bg-warning/15 text-warning"
                        : it.answered
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border bg-surface-1 text-muted-foreground hover:bg-surface-2",
                    )}
                  >
                    <span>{i + 1}</span>
                    {it.timeMs > 0 && (
                      <span className="type-numeric text-[9px] leading-none text-muted-foreground">
                        {formatMs(it.timeMs)}
                      </span>
                    )}
                    {/* Flag + elimination markers (progress only). */}
                    {it.flagged && (
                      <Flag className="absolute right-1 top-1 h-2.5 w-2.5" aria-hidden />
                    )}
                    {it.hasEliminations && !it.flagged && (
                      <Scissors
                        className="absolute right-1 top-1 h-2.5 w-2.5 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    {dot && (
                      <span
                        aria-hidden
                        className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
                        style={{ backgroundColor: dot }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend — strictly progress vocabulary, never correctness. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t p-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-sm border border-primary/40 bg-primary/10" />
                Answered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-sm border border-border bg-surface-1" />
                Unanswered
              </span>
              <span className="flex items-center gap-1.5">
                <Icon as={Flag} size="xs" className="text-warning" />
                Flagged
              </span>
              <span className="flex items-center gap-1.5">
                <Icon as={Scissors} size="xs" />
                Eliminations
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Icon as={CheckCheck} size="xs" />
                Progress only — no answers shown
              </span>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
