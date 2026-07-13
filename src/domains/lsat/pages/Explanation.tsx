import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BookOpen,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Target,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { Textarea } from "@lsat/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnnotatedText } from "@lsat/components/question/annotated-text";
import { ReadingControls } from "@lsat/components/question/reading-controls";
import { TypeBadge } from "@lsat/components/viz";
import { PageLayout } from "@lsat/components/page-layout";
import { DockedCoach } from "@lsat/components/coach/docked-coach";
import { WidgetBoundary } from "@lsat/components/error-boundary";
import { EmptyState, LoadingState } from "@lsat/components/states";
import {
  streamExplain,
  type NotebookContextMeta,
  type SocraticExplainMeta,
} from "@lsat/lib/api";
import { TrapPatternsAccordion } from "@lsat/components/explanation/trap-patterns-accordion";
import type { TrapPattern } from "@lsat/lib/types-lsat2";
import {
  useAddErrorLog,
  useBulkSrsCards,
  useExplainFeedback,
} from "@lsat/lib/mutations";
import { useAiHealth, useQuestion, useSessionResults } from "@lsat/lib/hooks";
import { SimilarQuestions } from "@lsat/components/explanation/similar-questions";
import { ChoiceBreakdown } from "@lsat/components/explanation/choice-breakdown";
import { TimedBrAnswers } from "@lsat/components/explanation/timed-br-answers";
import { getQuestionAnnotations } from "@lsat/lib/annotationPrefs";
import { getUserExplanation, getAnnotationTags } from "@lsat/components/review/annotation-inline-editor";
import { ERROR_REASONS, difficultyStars } from "@lsat/lib/labels";
import { getNotes, readingClasses, useReadingPrefs } from "@lsat/lib/prefs";
import { cn } from "@lsat/lib/utils";
import type { ErrorReason } from "@lsat/lib/types";

// A1.5 — the markdown renderer (react-markdown + remark-gfm, ~47KB) is lazy so
// the explanation shell paints before this heavy body loads.
const AiMarkdown = lazy(() => import("@lsat/components/explanation/ai-markdown"));

export function offlineCoachProviderHint(provider: string | undefined) {
  return provider === "lmstudio"
    ? "your LMStudio server (localhost:1234)"
    : "Ollama (localhost:11434)";
}

export default function Explanation() {
  const { questionId } = useParams();
  const [searchParams] = useSearchParams();
  const id = Number(questionId);
  const attemptId = Number(searchParams.get("attempt") || 0) || null;
  const sessionId = Number(searchParams.get("session") || 0) || null;
  const sessionResults = useSessionResults(sessionId || 0);
  const navigate = useNavigate();
  const [reading, setReading] = useReadingPrefs();
  const addErrorLog = useAddErrorLog();
  const bulkSrs = useBulkSrsCards();
  const explainFeedback = useExplainFeedback();

  // Provider-aware offline copy: name the ACTIVE local provider in the
  // "AI coach is offline" fallback instead of always saying Ollama. Held in a
  // ref so the stream's onError closure always reads the latest value.
  const aiHealth = useAiHealth();
  const aiProvider = aiHealth.data?.data?.provider ?? "ollama";
  const aiProviderRef = useRef(aiProvider);
  useEffect(() => {
    aiProviderRef.current = aiProvider;
  }, [aiProvider]);

  // Forward the reveal context so the answer-key fetch is authorized (else 403).
  const questionQuery = useQuestion(id, true, { attemptId, sessionId });
  const question = questionQuery.data?.data ?? null;
  const loading = questionQuery.isLoading;

  // AI streaming state
  const [aiText, setAiText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [cached, setCached] = useState(false);          // A2
  const [aiError, setAiError] = useState(false);        // A3
  const [perChoice, setPerChoice] = useState<Record<string, string>>({}); // A4
  const [notebookContext, setNotebookContext] = useState<NotebookContextMeta | null>(null);
  const [socraticContext, setSocraticContext] = useState<SocraticExplainMeta | null>(null);
  const [trapPatterns, setTrapPatterns] = useState<TrapPattern[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastAskRef = useRef<{ userMessage?: string; focusChoice?: string | null } | null>(null);

  // Choice highlighted by hovering/clicking an AI citation.
  const [spotlight, setSpotlight] = useState<string | null>(null);

  // Q1 — explanation feedback (👍/👎 + optional note on 👎).
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);
  const [showFeedbackNote, setShowFeedbackNote] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");

  // Error-log form
  const [reason, setReason] = useState<ErrorReason>("trap");
  const [note, setNote] = useState("");
  const [addSrs, setAddSrs] = useState(true);
  const [logged, setLogged] = useState(false);
  const explanationBody = question?.explanation?.body;
  const explanationPerChoice = question?.explanation?.per_choice;

  useEffect(() => {
    if (!explanationBody) return;
    setAiText(explanationBody);
    setCached(true);
    setNotebookContext(null);
    setTrapPatterns([]);
    setPerChoice(explanationPerChoice ?? {});
  }, [question?.id, explanationBody, explanationPerChoice]);

  const attemptItem = useMemo(() => {
    const items = sessionResults.data?.data.items ?? [];
    if (attemptId) {
      return items.find((i) => i.attempt.attempt_id === attemptId);
    }
    return items.find((i) => i.question.id === id);
  }, [sessionResults.data, attemptId, id]);

  const chosen = attemptItem?.attempt.chosen_answer ?? "—";
  const brAnswer = attemptItem?.attempt.br_answer ?? null;

  if (loading) return <LoadingState label="Loading explanation…" />;
  if (!question)
    return (
      <PageLayout title="Explanation" width="lg">
        <EmptyState
          title="Question not found"
          description="This question may have been removed or the link is invalid."
          action={<Button onClick={() => navigate("/review")}>Back to Review</Button>}
        />
      </PageLayout>
    );

  const q = question;
  const correct = q.correct_answer;
  const validLabels = q.choices.map((c) => c.label);
  const savedNotes = getNotes(q.id);
  const savedHighlights = getQuestionAnnotations(q.id);
  const userExplanation = getUserExplanation(q.id);
  const userTags = getAnnotationTags(q.id);
  const rcls = readingClasses(reading);

  function askCoach(opts?: { userMessage?: string; focusChoice?: string | null }) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    lastAskRef.current = opts ?? null;
    setAiText("");
    setPerChoice({});
    setNotebookContext(null);
    setSocraticContext(null);
    setTrapPatterns([]);
    setCached(false);
    setAiError(false);
    setStreaming(true);
    // Fresh explanation → reset any prior feedback affordance.
    setFeedbackGiven(null);
    setShowFeedbackNote(false);
    setFeedbackNote("");
    void streamExplain(
      {
        question_id: id,
        chosen_answer: chosen !== "—" ? chosen : null,
        attempt_id: attemptId,
        user_message: opts?.userMessage,         // A1 follow-up
        focus_choice: opts?.focusChoice ?? null, // A1 focus
      },
      {
        onToken: (t) => setAiText((prev) => prev + t),
        onChoice: (label, txt) =>
          setPerChoice((prev) => ({ ...prev, [label]: txt })), // A4
        // 5.7 — a reconnect re-streams from the start; clear partial output so
        // tokens are not duplicated.
        onReconnect: () => {
          setAiText("");
          setPerChoice({});
          setNotebookContext(null);
          setSocraticContext(null);
          setTrapPatterns([]);
        },
        onDone: (_eid, meta) => {
          setStreaming(false);
          if (meta?.cached) setCached(true);
          if (meta?.per_choice)
            setPerChoice((prev) => ({ ...prev, ...meta.per_choice }));
          setNotebookContext(meta?.notebook_context ?? null);
          setSocraticContext(meta?.socratic_context ?? null);
          setTrapPatterns(meta?.trap_patterns?.items ?? []);
        },
        onError: () => {
          setStreaming(false);
          setAiError(true);
          const hint = offlineCoachProviderHint(aiProviderRef.current);
          setAiText(
            (prev) =>
              prev ||
              `AI coach is offline. Start ${hint} to stream a live explanation here.`,
          );
        },
        signal: ctrl.signal,
      },
    );
  }

  function stopStream() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  function submitErrorLog() {
    if (!attemptId) return;
    addErrorLog.mutate(
      { attemptId, reason, note },
      {
        onSuccess: () => {
          setLogged(true);
          // Honour the "Add to SRS" checkbox by actually creating a card — the
          // success copy below promises it, so it must really happen.
          if (addSrs) bulkSrs.mutate([id]);
        },
      },
    );
  }

  function sendHelpful() {
    setFeedbackGiven("up");
    setShowFeedbackNote(false);
    explainFeedback.mutate({ question_id: id, helpful: true });
  }

  function startUnhelpful() {
    // First 👎 click reveals the optional note; a second confirms.
    setFeedbackGiven("down");
    setShowFeedbackNote(true);
  }

  function submitUnhelpful() {
    explainFeedback.mutate({
      question_id: id,
      helpful: false,
      note: feedbackNote.trim() || undefined,
    });
    setShowFeedbackNote(false);
  }

  return (
    <PageLayout
      title={`Question ${id}`}
      eyebrow="Explanation"
      icon={BookOpen}
      width="2xl"
      actions={<ReadingControls prefs={reading} onChange={setReading} />}
    >
    {/* R9 (docs/19) — reading-first layout. The explanation + per-choice are the
        primary, wide column with real hierarchy; the secondary actions (log
        error, drill, similar) are demoted to a narrow rail. The R8 `.reading` AI
        body + aria-live stream are preserved. */}
    <div
      className={cn(
        "grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]",
        reading.focusTheme && "theme-focus rounded-card p-4",
      )}
    >
      {/* ---- Primary column: the question, then the explanation as the hero. ---- */}
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <TypeBadge qType={q.q_type} />
          <span className="text-sm text-warning" title="Difficulty">
            {difficultyStars(q.difficulty)}
          </span>
        </div>

        <TimedBrAnswers timedAnswer={chosen} brAnswer={brAnswer} correct={correct ?? ""} />

        {q.stem && (
          <Card>
            <CardContent className="pt-6">
              <AnnotatedText
                text={q.stem}
                highlights={savedHighlights}
                activeColor={null}
                notes={savedNotes}
                readOnly
                className={rcls}
              />
              <p className="mt-3 break-words font-medium">{q.prompt}</p>
            </CardContent>
          </Card>
        )}

        {/* The explanation — the primary reading surface. Engraved header, the
            streamed `.reading` body, prompt chips for follow-ups. */}
        <section aria-label="Explanation" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Icon as={Sparkles} size="md" className="text-primary" />
            <h2 className="type-display text-xl leading-tight">The explanation</h2>
            {cached && !streaming && (
              <Badge variant="outline" className="text-muted-foreground">
                Cached
              </Badge>
            )}
            {socraticContext?.personalized && !streaming && (
              <Badge variant="outline" className="text-primary">
                Why loop
              </Badge>
            )}
            {!cached && aiText && !streaming && !aiError && (
              <Badge variant="outline" className="text-primary">
                Live
              </Badge>
            )}
            <div className="ml-auto flex gap-2">
              {aiError && !streaming && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => askCoach(lastAskRef.current ?? undefined)}
                >
                  <RotateCcw className="h-4 w-4" /> Retry
                </Button>
              )}
              {streaming ? (
                <Button size="sm" variant="outline" onClick={stopStream}>
                  <Square className="h-4 w-4" /> Stop
                </Button>
              ) : (
                <Button size="sm" onClick={() => askCoach()}>
                  <Send className="h-4 w-4" /> Explain my answer
                </Button>
              )}
            </div>
          </div>

          {/* K2 — announce streamed content to assistive tech (preserved). */}
          <div
            className="min-h-[120px] rounded-card border bg-card p-5"
            role="status"
            aria-live="polite"
          >
            {aiText ? (
              <Suspense
                fallback={
                  <p className={cn(rcls, "whitespace-pre-wrap")}>{aiText}</p>
                }
              >
                <AiMarkdown
                  text={aiText}
                  streaming={streaming}
                  validLabels={validLabels}
                  onSpotlight={setSpotlight}
                  readingClassName={rcls}
                />
              </Suspense>
            ) : (
              <p className="type-counsel text-muted-foreground">
                Ask for an explanation and it streams here, token by token. Choice
                references like (A) highlight that choice in the breakdown below.
              </p>
            )}
          </div>
          {notebookContext?.items.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="text-[11px]">
                Notebook
              </Badge>
              {notebookContext.items.slice(0, 4).map((item) => (
                <span key={`${item.kind}-${item.id}`} className="max-w-[18rem] truncate">
                  {item.title}
                </span>
              ))}
            </div>
          ) : null}

          {trapPatterns.length ? (
            <TrapPatternsAccordion patterns={trapPatterns} />
          ) : null}

          {/* Follow-up prompts. */}
          <div className="flex flex-wrap gap-2">
            {spotlight && validLabels.includes(spotlight) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  askCoach({ userMessage: `Why is (${spotlight}) wrong?`, focusChoice: spotlight })
                }
                disabled={streaming}
              >
                Why is ({spotlight}) wrong?
              </Button>
            )}
            {[
              "What's the fastest way to spot this?",
              "Explain the correct answer.",
              "What trap am I falling for?",
            ].map((p) => (
              <Button
                key={p}
                variant="outline"
                size="sm"
                onClick={() => askCoach({ userMessage: p, focusChoice: spotlight })}
                disabled={streaming}
              >
                {p}
              </Button>
            ))}
          </div>

          {/* Q1 — rate the explanation. */}
          {aiText && !streaming && !aiError && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-xs text-muted-foreground">
                Was this explanation helpful?
              </span>
              <Button
                size="icon"
                variant={feedbackGiven === "up" ? "default" : "outline"}
                className="h-7 w-7"
                onClick={sendHelpful}
                disabled={explainFeedback.isPending}
                aria-pressed={feedbackGiven === "up"}
                aria-label="Mark explanation helpful"
                title="Helpful"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant={feedbackGiven === "down" ? "destructive" : "outline"}
                className="h-7 w-7"
                onClick={startUnhelpful}
                disabled={explainFeedback.isPending}
                aria-pressed={feedbackGiven === "down"}
                aria-label="Mark explanation unhelpful"
                title="Not helpful — regenerate next time"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </Button>
              {showFeedbackNote && (
                <div className="mt-2 w-full space-y-2">
                  <Textarea
                    value={feedbackNote}
                    onChange={(e) => setFeedbackNote(e.target.value)}
                    rows={2}
                    placeholder="Optional: what was off? (helps the next regeneration)"
                    className="resize-none text-sm"
                    aria-label="Explanation feedback note"
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setShowFeedbackNote(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={submitUnhelpful}
                      disabled={explainFeedback.isPending}
                    >
                      Submit feedback
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {(userExplanation || userTags.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your explanation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {userExplanation && (
                <p className={cn(rcls, "whitespace-pre-wrap")}>{userExplanation}</p>
              )}
              {userTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {userTags.map((t) => (
                    <Badge key={t} variant="secondary">{t}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Per-choice breakdown — secondary to the prose but still primary-column. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-choice breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <ChoiceBreakdown
              choices={q.choices}
              correctAnswer={correct}
              chosen={chosen}
              perChoiceNote={
                Object.keys(perChoice).length ? perChoice : q.explanation?.per_choice
              }
              spotlight={spotlight}
              onSpotlight={setSpotlight}
            />
          </CardContent>
        </Card>
      </div>

      {/* ---- Secondary rail: demoted actions + similar. ---- */}
      <aside className="space-y-4 lg:border-l lg:pl-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="type-overline text-muted-foreground">
              Log this error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {logged ? (
              <p className="text-sm text-success">
                Logged{addSrs ? " and added to SRS" : ""}.
              </p>
            ) : (
              <>
                <Select value={reason} onValueChange={(v) => setReason(v as ErrorReason)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ERROR_REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  placeholder="What happened? (e.g. read 'weakens' as 'strengthens' under pressure)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={addSrs}
                    onChange={(e) => setAddSrs(e.target.checked)}
                  />
                  <Plus className="h-3.5 w-3.5" /> Add to SRS
                </label>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={submitErrorLog}
                  loading={addErrorLog.isPending}
                  disabled={!attemptId}
                  title={
                    attemptId
                      ? undefined
                      : "Open from blind review or review queue to attach an attempt"
                  }
                >
                  {addErrorLog.isPending ? "Saving…" : "Save to error log"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="type-overline text-muted-foreground">
              Keep practicing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                navigate(`/drills?q_type=${encodeURIComponent(String(q.q_type))}`)
              }
            >
              <Target className="h-4 w-4" />
              Drill this type
            </Button>
          </CardContent>
        </Card>

        <WidgetBoundary label="Similar questions" resetKey={id}>
          <SimilarQuestions questionId={id} qType={q.q_type} />
        </WidgetBoundary>
      </aside>
    </div>
    <WidgetBoundary label="AI coach">
      <DockedCoach scope="explanation" />
    </WidgetBoundary>
    </PageLayout>
  );
}
