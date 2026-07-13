import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { ChoiceList } from "@lsat/components/question/choice-list";
import { LiveRegion } from "@lsat/components/question/live-region";
import { OutcomeActions } from "@lsat/components/blind-review/outcome-actions";
import { OUTCOME_META } from "@lsat/lib/labels";
import { cn } from "@lsat/lib/utils";
import { duration, easing } from "@lsat/lib/motion";
import type { Choice, Outcome, QType } from "@lsat/lib/types";

// 5.6 — spoken summary of the 2×2 (timed ✓/✗ × blind-review ✓/✗) on reveal.
const OUTCOME_ANNOUNCEMENT: Record<Outcome, string> = {
  timed_ok: "you were correct when timed; blind-review correct",
  timing_problem: "you were incorrect when timed; blind-review correct",
  concept_gap: "you were incorrect when timed; blind-review incorrect",
  lucky: "you were correct when timed; blind-review incorrect",
};

// R8 "The Reckoning" — the verdict, spoken in the serif counsel voice. This is a
// presentation restatement of the *already-known* outcome (derived from
// `outcome` / OUTCOME_META, never new answer data): a calm sentence that lands
// the moment the correct answer settles.
const VERDICT_LINE: Record<Outcome, string> = {
  timed_ok: "You earned this one — under time, and again on reflection.",
  timing_problem: "You knew it. The clock was the only thing in your way.",
  concept_gap: "This one slipped both times. It is a concept to rebuild.",
  lucky: "The mark was right, but the reasoning was not. Don't bank on it.",
};

// Tone of the verdict prose, mirroring the OUTCOME_META variant so all four
// themes re-color through tokens (no hardcoded hex).
const VERDICT_TONE: Record<Outcome, string> = {
  timed_ok: "text-success",
  timing_problem: "text-warning",
  concept_gap: "text-destructive",
  lucky: "text-muted-foreground",
};

type Phase = "hold" | "ignite";

export function RevealedBlock({
  outcome,
  qType,
  metaVariant,
  metaLabel,
  metaDescription,
  choices,
  chosen,
  correctAnswer,
  perChoice,
  srsAdded,
  onAddSrs,
  onExplain,
}: {
  outcome: Outcome;
  qType: QType;
  metaVariant: "success" | "warning" | "destructive" | "secondary";
  metaLabel: string;
  metaDescription: string;
  choices: Choice[];
  chosen: string | null;
  correctAnswer?: string;
  perChoice?: Record<string, string>;
  srsAdded: boolean;
  onAddSrs: () => void;
  onExplain: () => void;
}) {
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const bucket = OUTCOME_META[outcome];

  // R8 "The Reckoning" — a brief hold→settle beat. On reveal the truth table is
  // first held in a calm, neutral state (the verdict withheld — no cell tone, no
  // ✓/✗ correctness revealed), THEN the correct answer settles and the user's
  // own outcome cell ignites while the rest recede. The hold withholds the
  // *verdict* (the 2x2 cell tone + the serif verdict line); the answer key in the
  // ChoiceList is already shown because the user explicitly clicked Reveal — so
  // nothing not-yet-earned is exposed during the hold.
  // Under reduced motion we resolve straight to the settled state (no hold, no
  // pulse). The block mounts fresh on reveal, so this runs once per question.
  const [phase, setPhase] = useState<Phase>(reduce ? "ignite" : "hold");
  useEffect(() => {
    if (reduce) return;
    const t = window.setTimeout(() => setPhase("ignite"), 580);
    return () => window.clearTimeout(t);
  }, [reduce]);
  const settled = phase === "ignite";

  // 5.6 — on reveal, move keyboard focus to the result heading so a screen
  // reader (and keyboard users) land on the outcome rather than staying on the
  // now-removed Reveal button. This block mounts fresh on reveal.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="space-y-4">
      {/* Assertive callout of the 2×2 outcome the moment the answer is revealed. */}
      <LiveRegion message={`Revealed: ${OUTCOME_ANNOUNCEMENT[outcome]}`} assertive />
      <m.div
        initial={reduce ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduce ? 0 : duration.slow, ease: easing.emphasized }}
        className={cn(
          // The color settle shares the ignite cell's `duration.celebrate` (500ms) tween.
          "rounded-card border p-4 transition-colors duration-500",
          // The verdict tone only blooms once the answer settles; during the
          // hold the callout stays calm/neutral so it leaks nothing.
          settled && metaVariant === "success" && "border-success/40 bg-success-subtle glow-verdict",
          settled && metaVariant === "warning" && "border-warning/40 bg-warning-subtle glow-verdict",
          settled && metaVariant === "destructive" && "border-destructive/40 bg-destructive-subtle glow-verdict",
          settled && metaVariant === "secondary" && "border-border bg-muted",
          !settled && "border-border bg-surface-1",
        )}
      >
        <div className="mb-3 flex min-h-7 items-center gap-2">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="flex items-center gap-2 text-base font-semibold outline-none"
          >
            {/* Always available to screen readers the instant focus lands here;
                the visual badge settles in after the hold for sighted users. */}
            <span className="sr-only">{metaLabel}</span>
            {settled ? (
              <>
                <Badge variant={metaVariant} aria-hidden="true">
                  {metaLabel}
                </Badge>
                <span aria-hidden="true" className="text-sm font-normal text-muted-foreground">
                  {metaDescription}
                </span>
              </>
            ) : (
              <span
                aria-hidden="true"
                className="type-overline text-muted-foreground"
              >
                Reading the verdict…
              </span>
            )}
          </h2>
        </div>

        {/* The serif verdict — lands as the answer settles. Decorative
            reinforcement: the outcome is already spoken by the LiveRegion and
            the heading, so this is aria-hidden to avoid a triple announcement. */}
        <m.p
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: settled ? 1 : 0, y: settled ? 0 : 6 }}
          transition={{ duration: reduce ? 0 : duration.celebrate, ease: easing.emphasized }}
          aria-hidden="true"
          className={cn("type-display mb-4 text-lg leading-snug", VERDICT_TONE[outcome])}
        >
          {VERDICT_LINE[outcome]}
        </m.p>

        <div className="grid max-w-md grid-cols-3 gap-px overflow-hidden rounded border bg-border text-center text-xs">
          <div className="bg-card p-2" />
          <div className="bg-card p-2 font-medium text-muted-foreground">BR ✓</div>
          <div className="bg-card p-2 font-medium text-muted-foreground">BR ✗</div>
          <div className="bg-card p-2 font-medium text-muted-foreground">Timed ✓</div>
          <OutcomeCell active={outcome === "timed_ok"} tone="success" settled={settled}>
            Solid
          </OutcomeCell>
          <OutcomeCell active={outcome === "lucky"} tone="secondary" settled={settled}>
            Lucky
          </OutcomeCell>
          <div className="bg-card p-2 font-medium text-muted-foreground">Timed ✗</div>
          <OutcomeCell active={outcome === "timing_problem"} tone="warning" settled={settled}>
            Timing
          </OutcomeCell>
          <OutcomeCell active={outcome === "concept_gap"} tone="destructive" settled={settled}>
            Concept
          </OutcomeCell>
        </div>
      </m.div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-surface-1 px-3 py-2 text-sm">
        <div>
          <span className="font-medium">Review bucket:</span>{" "}
          <Badge variant={bucket.variant}>{bucket.label}</Badge>
          <span className="ml-2 text-muted-foreground">{bucket.description}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate(`/review?tab=buckets`)}
        >
          Open bucket queue
        </Button>
      </div>

      <ChoiceList
        choices={choices}
        selected={chosen}
        eliminated={new Set()}
        onSelect={() => {}}
        onToggleEliminate={() => {}}
        reveal
        correctAnswer={correctAnswer}
        perChoiceNote={perChoice}
      />

      <OutcomeActions
        outcome={outcome}
        qType={qType}
        onAddSrs={onAddSrs}
        srsAdded={srsAdded}
      />
      <div className="flex justify-end">
        <Button onClick={onExplain}>Full explanation & AI coach</Button>
      </div>
    </div>
  );
}

function OutcomeCell({
  active,
  tone,
  settled,
  children,
}: {
  active: boolean;
  tone: "success" | "warning" | "destructive" | "secondary";
  settled: boolean;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const toneClass =
    tone === "success"
      ? "bg-success text-success-foreground"
      : tone === "warning"
        ? "bg-warning text-white"
        : tone === "destructive"
          ? "bg-destructive text-destructive-foreground"
          : "bg-muted-foreground/70 text-background";

  // Three visual states:
  //  - hold (!settled): every cell is neutral — the verdict is withheld.
  //  - settled + active: the user's outcome cell IGNITES (tone + aurora glow +
  //    the existing scale pulse).
  //  - settled + !active: the other cells RECEDE (dim + desaturate).
  const ignited = settled && active;
  const receded = settled && !active;

  return (
    <m.div
      initial={false}
      animate={ignited && !reduce ? { scale: [1, 1.06, 1] } : { scale: 1 }}
      transition={{ duration: duration.celebrate, ease: easing.emphasized }}
      className={cn(
        "p-2 transition-[background-color,color,opacity,filter] duration-500",
        ignited && cn("aurora font-semibold", toneClass),
        receded && "bg-card font-normal text-muted-foreground opacity-60 [filter:grayscale(0.4)]",
        !settled && "bg-card font-normal text-muted-foreground/80",
      )}
    >
      {children}
    </m.div>
  );
}
