import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { AnnotatedText } from "@/components/question/annotated-text";
import { ReadingControls } from "@/components/question/reading-controls";
import { BrAnswerPanel } from "@/components/blind-review/br-answer-panel";
import { RevealedBlock } from "@/components/blind-review/revealed-block";
import { TypeBadge } from "@/components/viz";
import { LoadingState, ErrorState } from "@/components/states";
import { useSessionResults } from "@/lib/hooks";
import { useAddErrorLog, useBulkSrsCards } from "@/lib/mutations";
import { api } from "@/lib/api";
import { enqueue } from "@/lib/offlineQueue";
import { cn } from "@/lib/utils";
import { OUTCOME_META } from "@/lib/labels";
import {
  getBrLastConfidence,
  getNotes,
  readingClasses,
  setBrLastConfidence,
  useReadingPrefs,
} from "@/lib/prefs";
import { getQuestionAnnotations } from "@/lib/annotationPrefs";
import { getKeyboardMap, resolveBrKey } from "@/lib/keyboardMap";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setResume } from "@/lib/resume";
import {
  buildBrWorksheetHtml,
  downloadBrWorksheet,
} from "@/lib/br-worksheet-export";
import type { Confidence, Outcome } from "@/lib/types";

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
    <div className={cn("flex h-full flex-col bg-background", reading.focusTheme && "theme-focus")}>
      <header className="flex h-14 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Logo className="h-5 w-5" />
          <h1 className="text-sm font-medium">Blind Review · No timer · Redo flagged + unsure</h1>
        </div>
        <div className="flex items-center gap-3">
          <Select value={filter} onValueChange={(v) => setFilter(v as BrFilter)}>
            <SelectTrigger className="w-32 h-8 text-xs">
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
            className="h-8 gap-1 text-xs"
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
            Worksheet
          </Button>
          <div className="text-sm text-muted-foreground tabular-nums">
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
