import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@lsat/components/logo";
import { AnnotatedText } from "@lsat/components/question/annotated-text";
import { ReadingControls } from "@lsat/components/question/reading-controls";
import { BrAnswerPanel } from "@lsat/components/blind-review/br-answer-panel";
import { RevealedBlock } from "@lsat/components/blind-review/revealed-block";
import { TypeBadge } from "@lsat/components/viz";
import { LoadingState, ErrorState } from "@lsat/components/states";
import { useSessionResults } from "@lsat/lib/hooks";
import { useAddErrorLog, useBulkSrsCards } from "@lsat/lib/mutations";
import { api } from "@lsat/lib/api";
import { postBlindReviewNote } from "@lsat/lib/gapCards";
import { toast } from "@lsat/lib/toast";
import { enqueue } from "@lsat/lib/offlineQueue";
import { cn } from "@lsat/lib/utils";
import { OUTCOME_META } from "@lsat/lib/labels";
import {
  getBrLastConfidence,
  getNotes,
  readingClasses,
  setBrLastConfidence,
  useReadingPrefs,
} from "@lsat/lib/prefs";
import { getQuestionAnnotations } from "@lsat/lib/annotationPrefs";
import { getKeyboardMap, resolveBrKey } from "@lsat/lib/keyboardMap";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setResume } from "@lsat/lib/resume";
import { SampleDataRecovery } from "@lsat/components/sample-data-recovery";
import {
  buildBrWorksheetHtml,
  downloadBrWorksheet,
} from "@lsat/lib/br-worksheet-export";
import type { Confidence, Outcome } from "@lsat/lib/types";

type BrFilter = "all" | "flagged" | "wrong";

export default function BlindReview() {
  const { sessionId } = useParams();
  const id = Number(sessionId);
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useSessionResults(id);
  const [reading, setReading] = useReadingPrefs();
  const addErrorLog = useAddErrorLog();
  const bulkSrs = useBulkSrsCards();

  const items = useMemo(() => data?.data.items ?? [], [data]);
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<BrFilter>(() => {
    const f = searchParams.get("filter");
    return f === "flagged" || f === "wrong" ? f : "all";
  });
  const queue = useMemo(() => {
    return items.filter((it) => {
      if (filter === "flagged") return it.attempt.flagged;
      if (filter === "wrong") return !it.attempt.is_correct;
      return true;
    });
  }, [items, filter]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [filter]);

  useEffect(() => {
    if (id <= 0) return;
    setResume({
      kind: "blind-review",
      label: `Blind review · Q${index + 1}`,
      path: `/blind-review/${id}`,
      index,
      updatedAt: new Date().toISOString(),
    });
  }, [id, index]);

  // 1.6 — full keyboard control. Arrows navigate; A–E commit a BR answer; 1/2/3
  // set confidence; R/Enter reveal (when allowed). The non-arrow actions need
  // values computed after the early-returns below, so the stable listener
  // delegates to a per-render handler kept in this ref.
  const brKeyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(queue.length - 1, i + 1));
        return;
      }
      brKeyHandlerRef.current?.(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue.length]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [brAnswers, setBrAnswers] = useState<Record<number, string | null>>({});
  const [confidence, setConfidence] = useState<Record<number, Confidence>>({});
  const [srsAdded, setSrsAdded] = useState<Record<number, boolean>>({});
  // LSAT-3 — the short reveal-time "why" the user types per question, and which
  // ones have already been saved to the backend (so the save button reads "Saved").
  const [brNotes, setBrNotes] = useState<Record<number, string>>({});
  const [noteSaved, setNoteSaved] = useState<Record<number, boolean>>({});

  if (isLoading)
    return (
      <BrShell>
        <LoadingState label="Loading section results…" />
      </BrShell>
    );
  if (isError || !data)
    return (
      <BrShell>
        <div className="mx-auto max-w-2xl p-8">
          <ErrorState error={error} onRetry={refetch} />
        </div>
      </BrShell>
    );
  // The query falls back to a built-in section when the LSAT service is
  // unreachable. That section is useful for keeping the shell paintable, but
  // it is not a learner attempt and must never enter blind review or grading.
  if (data.usingSample)
    return (
      <BrShell>
        <div className="mx-auto max-w-2xl p-8">
          <SampleDataRecovery
            section="Blind review"
            affectedSections={["Timed answers", "Blind-review answers", "Review outcomes"]}
            onRetry={() => refetch().then(() => undefined)}
          />
        </div>
      </BrShell>
    );
  if (items.length === 0)
    return (
      <BrShell>
        <div className="p-8 text-sm text-muted-foreground">No items.</div>
      </BrShell>
    );
  if (queue.length === 0)
    return (
      <BrShell>
        <div className="p-8 text-sm text-muted-foreground">
          No questions match this filter.
        </div>
      </BrShell>
    );

  const item = queue[index];
  const globalIndex = items.indexOf(item);
  const q = item.question;
  const isRevealed = !!revealed[globalIndex];
  const brAnswer = brAnswers[globalIndex] ?? null;
  const conf = confidence[globalIndex] ?? getBrLastConfidence();
  const brNote = brNotes[globalIndex] ?? "";
  const isNoteSaved = !!noteSaved[globalIndex];
  const savedNotes = getNotes(q.id);
  const savedHighlights = getQuestionAnnotations(q.id);

  function computeOutcome(): Outcome {
    const timedCorrect = item.attempt.is_correct;
    const brCorrect = brAnswer === q.correct_answer;
    if (timedCorrect && brCorrect) return "timed_ok";
    if (!timedCorrect && brCorrect) return "timing_problem";
    if (!timedCorrect && !brCorrect) return "concept_gap";
    return "lucky";
  }

  async function reveal() {
    if (!brAnswer) return;
    try {
      await api.blindReview(item.attempt.attempt_id, {
        br_answer: brAnswer,
        confidence: conf,
      });
    } catch {
      enqueue({
        kind: "blindReview",
        attemptId: item.attempt.attempt_id,
        body: { br_answer: brAnswer, confidence: conf },
      });
    }
    setRevealed((r) => ({ ...r, [globalIndex]: true }));
  }

  function addToSrs() {
    setSrsAdded((s) => ({ ...s, [globalIndex]: true }));
    // Log the concept gap AND create a real SRS card so the question actually
    // resurfaces in the review queue (the error-log entry alone never did).
    addErrorLog.mutate({
      attemptId: item.attempt.attempt_id,
      reason: "concept",
      note: "Added from Blind Review",
    });
    if (item.question?.id) bulkSrs.mutate([item.question.id]);
  }

  function commitBrAnswer(label: string) {
    setBrAnswers((b) => ({ ...b, [globalIndex]: label }));
  }

  // LSAT-3 — persist the reveal-time rationale. Optional + best-effort: the
  // reveal (br_answer) is already saved by `reveal()`, so a failed note save is
  // a soft toast, never a blocker, and the captured note also seeds the
  // auto-cloze "Gap" card pattern line on the backend.
  async function saveNote() {
    const note = brNote.trim();
    if (!note) return;
    try {
      await postBlindReviewNote(item.attempt.attempt_id, {
        br_note: note,
        answer: brAnswer,
        confidence: conf,
      });
      setNoteSaved((n) => ({ ...n, [globalIndex]: true }));
      toast.success("Takeaway saved");
    } catch {
      toast.error("Could not save takeaway (backend offline)");
    }
  }

  function setConf(c: Confidence) {
    setBrLastConfidence(c);
    setConfidence((cf) => ({ ...cf, [globalIndex]: c }));
  }

  // 1.6 — live keyboard handler (see the ref wiring above). Only active before
  // reveal for commit/confidence; reveal itself respects the same gate as the
  // button (a BR answer must be committed first).
  brKeyHandlerRef.current = (e: KeyboardEvent) => {
    const action = resolveBrKey(e, getKeyboardMap());
    if (!action) return;
    if (action.kind === "reveal") {
      if (!isRevealed && brAnswer) {
        e.preventDefault();
        void reveal();
      }
      return;
    }
    if (isRevealed) return; // panel is gone; ignore commit/confidence keys
    if (action.kind === "answer") {
      // Don't accept a letter that this question doesn't offer (e.g. E on a 4-up).
      if (!q.choices.some((c) => c.label === action.label)) return;
      e.preventDefault();
      commitBrAnswer(action.label);
      return;
    }
    if (action.kind === "confidence") {
      e.preventDefault();
      setConf(action.value);
    }
  };

  const outcome = computeOutcome();
  const meta = OUTCOME_META[outcome];
  const rcls = readingClasses(reading);

  return (
    <div
      className={cn(
        "assessment-runner flex h-full min-w-0 flex-col bg-background",
        reading.focusTheme && "theme-focus",
      )}
    >
      <header className="flex h-14 min-w-0 items-center justify-between gap-3 border-b px-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          <Logo className="h-5 w-5" />
          <h1 className="min-w-0 truncate text-sm font-medium">
            <span className="hidden sm:inline">Blind Review · No timer · Redo flagged + unsure</span>
            <span className="sm:hidden">Blind Review</span>
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          <Select value={filter} onValueChange={(v) => setFilter(v as BrFilter)}>
            <SelectTrigger className="h-10 w-20 text-xs sm:h-8 sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="flagged">Flagged</SelectItem>
              <SelectItem value="wrong">Missed</SelectItem>
            </SelectContent>
          </Select>
          <ReadingControls prefs={reading} onChange={setReading} />
          <Button
            variant="outline"
            size="sm"
            className="h-10 gap-1 px-2 text-xs sm:h-8 sm:px-3"
            onClick={() => {
              const html = buildBrWorksheetHtml(
                `Session ${id}`,
                items.map((it) => it),
              );
              downloadBrWorksheet(
                html,
                `br-worksheet-${id}-${new Date().toISOString().slice(0, 10)}.html`,
              );
            }}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Worksheet</span>
          </Button>
          <div className="text-xs text-muted-foreground tabular-nums sm:text-sm">
            {index + 1} / {queue.length}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="flex items-center gap-2">
            <TypeBadge qType={q.q_type} />
            <span className="text-sm text-muted-foreground">
              Your timed answer:{" "}
              <span className="font-semibold text-foreground">
                {item.attempt.chosen_answer ?? "—"}
              </span>
            </span>
          </div>

          {q.stem && (
            <AnnotatedText
              text={q.stem}
              highlights={savedHighlights}
              activeColor={null}
              notes={savedNotes}
              readOnly
              className={rcls}
            />
          )}
          <p className="font-medium">{q.prompt}</p>

          {!isRevealed ? (
            <BrAnswerPanel
              choices={q.choices}
              selected={brAnswer}
              confidence={conf}
              onSelect={commitBrAnswer}
              onConfidence={setConf}
              onReveal={reveal}
              canReveal={!!brAnswer}
            />
          ) : (
            <>
              <RevealedBlock
                outcome={outcome}
                qType={q.q_type}
                metaVariant={meta.variant}
                metaLabel={meta.label}
                metaDescription={meta.description}
                choices={q.choices}
                chosen={item.attempt.chosen_answer}
                correctAnswer={q.correct_answer}
                perChoice={q.explanation?.per_choice}
                srsAdded={!!srsAdded[globalIndex]}
                onAddSrs={addToSrs}
                onExplain={() =>
                  navigate(
                    `/explanation/${q.id}?attempt=${item.attempt.attempt_id}&session=${id}`,
                  )
                }
              />
              {/* LSAT-3 — reveal-time rationale capture. Optional: a one-line
                  takeaway in your own words, saved to the backend where it also
                  seeds the auto-generated "Gap" cloze card's pattern line. */}
              <div className="space-y-2 rounded-card border bg-surface-1 p-4">
                <label
                  htmlFor={`br-note-${globalIndex}`}
                  className="text-sm font-medium"
                >
                  Why was this the answer? (optional)
                </label>
                <textarea
                  id={`br-note-${globalIndex}`}
                  value={brNote}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBrNotes((n) => ({ ...n, [globalIndex]: v }));
                    setNoteSaved((n) => ({ ...n, [globalIndex]: false }));
                  }}
                  rows={3}
                  placeholder="In your own words — the move this question turned on, or the trap you fell for."
                  className="w-full resize-y rounded-card border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void saveNote()}
                    disabled={!brNote.trim() || isNoteSaved}
                  >
                    {isNoteSaved ? "Saved" : "Save takeaway"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
        >
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        {index === queue.length - 1 ? (
          <Button size="sm" onClick={() => navigate("/review")}>
            Done — go to Review
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIndex((i) => Math.min(queue.length - 1, i + 1))}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </footer>
    </div>
  );
}

/**
 * Shared chrome for Blind Review's no-data states (loading / error / empty).
 * Mirrors the loaded page's `bg-background` surface and Logo identity header so
 * those states no longer read as bare, context-free spinners. Behavior is
 * unchanged — only the surrounding frame is consistent.
 */
function BrShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 items-center border-b px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Logo className="h-5 w-5" />
          <span>Blind Review · No timer · Redo flagged + unsure</span>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center overflow-y-auto">
        <div className="w-full">{children}</div>
      </div>
    </div>
  );
}
