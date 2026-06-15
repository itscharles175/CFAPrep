import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { m, useReducedMotion } from "motion/react";
import { BookOpen, Check, Layers, RotateCcw, Sparkles } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { ChoiceList } from "@lsat/components/question/choice-list";
import { PageLayout } from "@lsat/components/page-layout";
import { IllustrationSrsCaughtUp } from "@lsat/components/illustrations";
import { LoadingState, ErrorState, EmptyState } from "@lsat/components/states";
import { useSrsDue } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import { generateConceptGapCards, isGapCard } from "@lsat/lib/gapCards";
import { enqueue } from "@lsat/lib/offlineQueue";
import { qTypeLabel, srsOriginLabel } from "@lsat/lib/labels";
import { toast } from "@lsat/lib/toast";
import { cn } from "@lsat/lib/utils";
import { duration, easing } from "@lsat/lib/motion";

const RATINGS: { value: 1 | 2 | 3 | 4; label: string; hint: string }[] = [
  { value: 1, label: "Again", hint: "Forgot — see it soon" },
  { value: 2, label: "Hard", hint: "Recalled with effort" },
  { value: 3, label: "Good", hint: "Recalled correctly" },
  { value: 4, label: "Easy", hint: "Instant recall" },
];

/** Format a predicted interval (days) compactly. */
function fmtInterval(days: number): string {
  if (days < 1) return "<1d";
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}y`;
}

export default function Srs() {
  const { data, isLoading, isError, error, refetch } = useSrsDue();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Which grade button is hovered/focused, to preview its interval on the arc.
  const [hoverGrade, setHoverGrade] = useState<1 | 2 | 3 | 4 | null>(null);
  // LSAT-3 — in-flight guard for the auto-cloze "Gap" card generation action.
  const [generatingGaps, setGeneratingGaps] = useState(false);
  // R10 A4.1 — monotonic token guarding the optimistic "next due" line so a slow
  // background review response can't overwrite a line a later grade/Undo owns.
  const reviewToken = useRef(0);

  // LSAT-3 — turn the concept-gap queue into cloze/pattern "Gap" SRS cards, then
  // refresh the due list so the new cards surface immediately.
  async function generateGapCards() {
    setGeneratingGaps(true);
    try {
      const res = await generateConceptGapCards();
      if (res.generated > 0) {
        toast.success(
          `Built ${res.generated} gap card${res.generated === 1 ? "" : "s"}`,
        );
        void qc.invalidateQueries({ queryKey: ["srs-due"] });
      } else {
        toast.success("No new concept gaps to turn into cards");
      }
    } catch {
      toast.error("Could not build gap cards (backend offline)");
    } finally {
      setGeneratingGaps(false);
    }
  }

  if (isLoading)
    return (
      <PageLayout title="SRS" eyebrow="Spaced repetition" icon={Layers} width="md">
        <LoadingState label="Loading due cards…" />
      </PageLayout>
    );
  if (isError || !data)
    return (
      <PageLayout title="SRS" eyebrow="Spaced repetition" icon={Layers} width="md">
        <ErrorState error={error} onRetry={refetch} />
      </PageLayout>
    );

  const cards = data.data.cards;
  if (cards.length === 0)
    return (
      <PageLayout
        title="SRS"
        eyebrow="Spaced repetition"
        icon={Layers}
        description="Missed questions resurface here on the spaced-repetition schedule."
        width="md"
      >
        <EmptyState
          illustration={<IllustrationSrsCaughtUp />}
          title="No cards due"
          description="Nothing to review right now. Missed questions resurface here on the spaced-repetition schedule."
          action={
            <Button
              variant="outline"
              onClick={() => void generateGapCards()}
              disabled={generatingGaps}
            >
              <Sparkles className="h-4 w-4" />
              {generatingGaps ? "Building…" : "Build gap cards"}
            </Button>
          }
        />
      </PageLayout>
    );

  if (index >= cards.length)
    return (
      <PageLayout title="SRS" eyebrow="Spaced repetition" icon={Layers} width="md">
        <EmptyState
          title={`Reviewed ${completed} card${completed === 1 ? "" : "s"}`}
          description="You're done for today. The schedule will resurface the next batch when it's due."
          action={
            <Button
              onClick={() => {
                setIndex(0);
                setCompleted(0);
              }}
            >
              <RotateCcw className="h-4 w-4" /> Review again
            </Button>
          }
        />
      </PageLayout>
    );

  const card = cards[index];
  // LSAT-3 — an auto-cloze "Gap" card gets its own short badge rather than the
  // auto-title-cased origin label; the cloze body is rendered below.
  const isGap = isGapCard(card.origin);
  const originLabel = isGap ? "Gap" : srsOriginLabel(card.origin);
  // Interval preview comes from the due payload when the backend precomputes it.
  const previews = card.predicted_intervals ?? null;
  const gotItRight = revealed && selected === card.correct_answer;

  // R10 A4.1 — optimistic grading. The FSRS grade semantics and review
  // sequencing are unchanged: we still POST exactly one /srs/{card}/review per
  // grade, in order, with the same rating. Only the UI *timing* changes — we
  // advance to the next card immediately (using the precomputed
  // `predicted_intervals` for the "next due" line) and fire the review in the
  // background, reconciling the line with the server's realized interval when it
  // lands and falling back to the offline-sync message on failure. Undo still
  // restores the prior card exactly as before.
  function rate(rating: 1 | 2 | 3 | 4) {
    const prevIndex = index;
    const prevCompleted = completed;
    const prevSelected = selected;
    const prevRevealed = revealed;
    const gradedCardId = card.card_id;
    // This grade owns the result line only until the next card is graded; a
    // later grade (or Undo) bumps the token so a slow response can't clobber it.
    const token = ++reviewToken.current;

    // Optimistic "next due" from the precomputed preview, if the backend sent
    // one; otherwise stay silent until the real interval lands.
    const predicted = card.predicted_intervals?.[String(rating)];
    setLastResult(
      predicted != null ? `Next due in about ${fmtInterval(predicted)}.` : null,
    );

    // Advance immediately — the grade no longer waits on the round-trip.
    setCompleted((c) => c + 1);
    setIndex((i) => i + 1);
    setSelected(null);
    setRevealed(false);
    setHoverGrade(null);

    // Fire the review in the background. On success, reconcile the line with the
    // server's realized interval; on failure, queue it offline (parity with the
    // pre-R10 catch) so the schedule syncs when the backend returns.
    void api
      .srsReview(gradedCardId, rating)
      .then((r) => {
        if (reviewToken.current === token) {
          setLastResult(`Next due in ${r.interval_days} day(s).`);
        }
      })
      .catch(() => {
        enqueue({ kind: "srsReview", cardId: gradedCardId, rating });
        if (reviewToken.current === token) {
          setLastResult("Saved (offline — schedule will sync when backend is up).");
        }
      });

    toast.success("Rating saved", {
      action: {
        label: "Undo",
        onClick: () => {
          // Invalidate the in-flight result line so its late response is ignored.
          reviewToken.current++;
          setIndex(prevIndex);
          setCompleted(prevCompleted);
          setSelected(prevSelected);
          setRevealed(prevRevealed);
          setLastResult(null);
        },
      },
    });
  }

  return (
    <PageLayout
      title="SRS"
      eyebrow="Spaced repetition"
      icon={Layers}
      description="Questions you missed, scheduled for recall."
      width="md"
      actions={
        <Badge variant="secondary" className="type-numeric">
          {index + 1} / {cards.length} · {data.data.due_count} due
        </Badge>
      }
    >
      <div className="space-y-4">
        {lastResult && (
          <p className="text-xs text-muted-foreground" role="status">
            {lastResult}
          </p>
        )}

        {/* The card. On reveal it settles (a brief lift + glow-verdict) and the
            verdict + grade surface slides up under the recall side. */}
        <m.div
          // Re-key per card so the settle replays for each new card.
          key={card.card_id}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : duration.slow, ease: easing.emphasized }}
        >
          <Card
            className={cn(
              "overflow-hidden transition-shadow duration-500",
              revealed && "glow-verdict",
            )}
          >
            <CardContent className="space-y-4 p-[var(--card-pad)]">
              {/* Card identity row. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="type-display text-base">{qTypeLabel(card.q_type)}</span>
                  {originLabel && (
                    <Badge
                      variant={isGap ? "secondary" : "outline"}
                      className={cn(isGap && "gap-1")}
                      title={
                        isGap
                          ? "Auto-generated from a concept gap — recall the reasoning move"
                          : "Why you're reviewing this"
                      }
                    >
                      {isGap && <Sparkles className="h-3 w-3" />}
                      {originLabel}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => navigate(`/explanation/${card.id}`)}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Explanation
                </Button>
              </div>

              {/* Recall side. */}
              {card.stem && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{card.stem}</p>
              )}
              <p className="font-medium">{card.prompt}</p>
              <ChoiceList
                choices={card.choices}
                selected={selected}
                eliminated={new Set()}
                onSelect={setSelected}
                onToggleEliminate={() => {}}
                reveal={revealed}
                correctAnswer={card.correct_answer}
              />

              {!revealed ? (
                <Button
                  className="w-full"
                  disabled={!selected}
                  onClick={() => setRevealed(true)}
                >
                  Reveal &amp; rate
                </Button>
              ) : (
                <GradeSurface
                  ratings={RATINGS}
                  previews={previews}
                  hoverGrade={hoverGrade}
                  onHover={setHoverGrade}
                  onGrade={rate}
                  gotItRight={gotItRight}
                />
              )}
            </CardContent>
          </Card>
        </m.div>
      </div>
    </PageLayout>
  );
}

/**
 * R9 (docs/19 "SRS card as a premium flip/grade surface").
 *
 * The post-reveal verdict + grade surface. Replaces the flat 4-button grid +
 * 10px gray interval text with: a one-line serif verdict, then a *growing
 * interval arc* — each grade (Again → Easy) maps to a progressively longer sweep
 * of the arc, and the four grade buttons each show their predicted interval as
 * the primary numeral. Hovering/focusing a grade previews its sweep so the user
 * can see the interval grow before committing. Reduced-motion stills the sweep.
 *
 * Review context — no Test-Mode risk (this only appears after the user has
 * already revealed the answer).
 */
function GradeSurface({
  ratings,
  previews,
  hoverGrade,
  onHover,
  onGrade,
  gotItRight,
}: {
  ratings: { value: 1 | 2 | 3 | 4; label: string; hint: string }[];
  previews: Record<string, number> | null;
  hoverGrade: 1 | 2 | 3 | 4 | null;
  onHover: (g: 1 | 2 | 3 | 4 | null) => void;
  onGrade: (g: 1 | 2 | 3 | 4) => void;
  gotItRight: boolean;
}) {
  const reduce = useReducedMotion();
  // The arc fills further for higher grades. When nothing is hovered, default the
  // preview to the grade matching the recall result (Good if right, Again if not)
  // so the arc reads as a sensible suggestion rather than empty.
  const defaultGrade: 1 | 2 | 3 | 4 = gotItRight ? 3 : 1;
  const activeGrade = hoverGrade ?? defaultGrade;
  // Map grade 1..4 to a fill fraction along a quarter-ish growth curve.
  const fillFor = (g: number) => 0.12 + (g - 1) * (0.88 / 3); // 0.12 → 1.0
  const fill = fillFor(activeGrade);
  const activePreview = previews?.[String(activeGrade)];

  // Arc geometry — a wide, shallow top arc that sweeps left→right as the grade
  // (and thus the next interval) grows.
  const w = 280;
  const h = 96;
  const cx = w / 2;
  const cy = h - 6;
  const r = 116;
  const startAngle = Math.PI; // 180° (left)
  const sweep = Math.PI; // half-circle to the right
  const pointAt = (t: number) => {
    const a = startAngle + sweep * t;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const arcPath = (t0: number, t1: number) => {
    const p0 = pointAt(t0);
    const p1 = pointAt(t1);
    const large = t1 - t0 > 0.5 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`;
  };
  const knob = pointAt(fill);

  return (
    <div className="space-y-4 border-t pt-4">
      {/* One-line serif verdict. Neutral guidance — never shaming. */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            gotItRight ? "bg-success-subtle text-success" : "bg-warning-subtle text-warning",
          )}
        >
          <Icon as={gotItRight ? Check : RotateCcw} size="sm" />
        </span>
        <p className="type-counsel text-sm">
          {gotItRight
            ? "Recalled it. How hard was that?"
            : "Missed it — that's the point of review. Grade your recall honestly."}
        </p>
      </div>

      {/* The growing interval arc. */}
      <div className="flex flex-col items-center">
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="w-full max-w-[280px]"
          role="img"
          aria-label={
            activePreview != null
              ? `${ratings[activeGrade - 1].label}: next review in about ${fmtInterval(activePreview)}`
              : ratings[activeGrade - 1].label
          }
        >
          {/* Track. */}
          <path
            d={arcPath(0, 1)}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={6}
            strokeLinecap="round"
          />
          {/* Filled sweep — grows with the grade. */}
          <m.path
            d={arcPath(0, Math.max(0.001, fill))}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={6}
            strokeLinecap="round"
            initial={false}
            animate={{ d: arcPath(0, Math.max(0.001, fill)) }}
            transition={{ duration: reduce ? 0 : duration.slow, ease: easing.emphasized }}
          />
          {/* Knob at the current interval position. */}
          <m.circle
            r={7}
            fill="hsl(var(--primary))"
            stroke="hsl(var(--card))"
            strokeWidth={2.5}
            initial={false}
            animate={{ cx: knob.x, cy: knob.y }}
            transition={{ duration: reduce ? 0 : duration.slow, ease: easing.emphasized }}
          />
        </svg>
        <div className="-mt-2 text-center">
          <div className="type-numeric text-2xl font-semibold text-primary">
            {activePreview != null ? fmtInterval(activePreview) : "—"}
          </div>
          <div className="type-overline text-muted-foreground">next review</div>
        </div>
      </div>

      {/* Grade buttons — Again → Easy, the interval as the primary numeral. */}
      <div className="grid grid-cols-4 gap-2">
        {ratings.map((r) => {
          const preview = previews?.[String(r.value)];
          const isActive = activeGrade === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => onGrade(r.value)}
              onMouseEnter={() => onHover(r.value)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(r.value)}
              onBlur={() => onHover(null)}
              title={r.hint}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-card border px-1 py-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent",
              )}
            >
              <span className="text-sm font-medium">{r.label}</span>
              {preview != null && (
                <span
                  className={cn(
                    "type-numeric text-xs",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {fmtInterval(preview)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
