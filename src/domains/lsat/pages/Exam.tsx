import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Keyboard, PlayCircle } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lsat/components/ui/dialog";
import { LoadingState, ErrorState } from "@lsat/components/states";
import { PostExamHub } from "@lsat/components/exam/post-exam-hub";
import { Ceremony } from "@lsat/components/exam/ceremony";
import { SectionItinerary } from "@lsat/components/exam/section-itinerary";
import { RestRing } from "@lsat/components/exam/rest-ring";
import { SealedBeat } from "@lsat/components/exam/sealed-beat";
import { PreSubmitReview } from "@lsat/components/question/pre-submit-review";
import type { NavItem } from "@lsat/components/question/navigator-strip";
import {
  SectionRunner,
  blankState,
  type QState,
} from "@lsat/components/question/section-runner";
import { KEYBOARD_HELP_EVENT } from "@lsat/components/keyboard-help";
import { usePrepTest } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import {
  enqueueFinishSession,
  enqueueSectionAttempts,
} from "@lsat/lib/offlineQueue";
import { attemptIdFor, clearAttemptIds } from "@lsat/lib/attemptIds";
import { sampleSection } from "@lsat/lib/sample";
import { clearSessionDraft, draftKeyForExamSection } from "@lsat/lib/sessionDraft";
import type { AttemptCreateWire } from "@lsat/lib/apiTypes";
import { playSectionEndBeep } from "@lsat/lib/examSounds";
import { formatClock } from "@lsat/lib/utils";
import { ExamProgressMap } from "@lsat/components/exam/exam-progress-map";
import { SectionInterstitial } from "@lsat/components/exam/section-interstitial";
import { getAccommodations, getExamKiosk } from "@lsat/lib/prefs";
import { setFullscreen, notify } from "@lsat/lib/tauri";
import { recordPtSectionComplete } from "@lsat/lib/ptProgress";
import type { SectionDetail, SectionSummary } from "@lsat/lib/types";

type Phase =
  | { kind: "intro" }
  | { kind: "section"; i: number }
  // R9 — a brief "section sealed" closure beat between finish and the next stage.
  | { kind: "sealed"; finishedI: number; isLast: boolean }
  | { kind: "break"; nextI: number }
  | { kind: "done" };

export default function Exam() {
  const { preptestId } = useParams();
  const ptId = Number(preptestId);
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = usePrepTest(ptId);
  const detail = data?.data;

  const sections = useMemo<SectionSummary[]>(
    () => (detail?.sections ?? []).slice().sort((a, b) => a.order - b.order),
    [detail],
  );

  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [loaded, setLoaded] = useState<Record<number, SectionDetail>>({});
  const [states, setStates] = useState<Record<number, Record<number, QState>>>({});
  const [sessionIds, setSessionIds] = useState<Record<number, number | null>>({});
  const [loadingSection, setLoadingSection] = useState(false);
  const [showFinish, setShowFinish] = useState(false);
  const [finishIndex, setFinishIndex] = useState(0);
  const [timeExpired, setTimeExpired] = useState(false);
  const [completedThrough, setCompletedThrough] = useState(-1);
  const [jumpToIndex, setJumpToIndex] = useState<number | null>(null); // C9

  // C7 — leave kiosk fullscreen when the exam screen unmounts.
  useEffect(() => {
    return () => {
      if (getExamKiosk()) void setFullscreen(false);
    };
  }, []);
  // C10 — a single exam session spans all sections (POST /api/exams); attempts
  // record under one id and score combines across sections. The ref mirrors the
  // state so loadSection sees it synchronously right after creation. When the
  // create fails (offline), we fall back to a session per section.
  const [examSessionId, setExamSessionId] = useState<number | null>(null);
  const examSessionRef = useRef<number | null>(null);

  const loadSection = useCallback(
    async (i: number) => {
      const summary = sections[i];
      if (!summary || loaded[i]) return;
      setLoadingSection(true);
      let sd: SectionDetail;
      try {
        sd = await api.section(summary.id);
      } catch {
        sd = sampleSection(summary.id);
      }
      let sid: number | null = examSessionRef.current;
      if (sid == null) {
        // Offline / no exam session — fall back to a per-section session.
        try {
          const s = await api.createSession("full_exam", {
            section_id: summary.id,
            preptest_id: ptId,
          });
          sid = s.id;
        } catch {
          /* offline */
        }
      }
      setLoaded((p) => ({ ...p, [i]: sd }));
      setSessionIds((p) => ({ ...p, [i]: sid }));
      setLoadingSection(false);
    },
    [sections, loaded, ptId],
  );

  async function startSection(i: number) {
    await loadSection(i);
    setPhase({ kind: "section", i });
  }

  async function startExam() {
    // C7 — enter OS fullscreen for test fidelity when opted in (Tauri only).
    if (getExamKiosk()) void setFullscreen(true);
    try {
      const exam = await api.createExam(ptId);
      examSessionRef.current = exam.session_id;
      setExamSessionId(exam.session_id);
    } catch {
      examSessionRef.current = null; // per-section fallback
    }
    await startSection(0);
  }

  const persistSection = useCallback(
    async (i: number) => {
      const sd = loaded[i];
      const sid = sessionIds[i];
      const st = states[i] ?? {};
      const scope = sd ? draftKeyForExamSection(sd.id) : null;
      if (sd && sid != null) {
        // 5.2/1.2 — stable idempotency id + PoE trace per attempt; the id is
        // keyed by (exam-section scope, question) so a replay never duplicates.
        const attempts: AttemptCreateWire[] = sd.questions.map((q, qi) => {
          const s = st[qi] ?? blankState();
          return {
            question_id: q.id,
            mode: "timed",
            chosen_answer: s.answer,
            time_ms: Math.round(s.timeMs),
            flagged: s.flagged,
            choice_events: s.choiceEvents,
            client_attempt_id: attemptIdFor(scope, q.id),
          };
        });
        const singleExam = examSessionRef.current != null;
        try {
          // 5.2 — ONE batch request instead of a serial per-question POST loop.
          await api.createAttemptsBatch(sid, attempts);
          // In single-session mode we finish once, at the end of the exam.
          if (!singleExam) await api.finishSession(sid);
        } catch {
          enqueueSectionAttempts(sid, attempts);
          if (!singleExam) enqueueFinishSession(sid);
        }
      }
      // 1.5 — section submitted; drop its crash-safe draft + id map.
      if (scope) {
        clearSessionDraft(scope);
        clearAttemptIds(scope);
      }
    },
    [loaded, sessionIds, states],
  );

  async function confirmFinishSection(i: number) {
    setShowFinish(false);
    playSectionEndBeep();
    await persistSection(i);
    setCompletedThrough(i);
    recordPtSectionComplete(ptId, null, i + 1);
    const isLast = i >= sections.length - 1;
    if (isLast && examSessionRef.current != null) {
      // C10 — finish the single exam session once, at the very end.
      try {
        await api.finishSession(examSessionRef.current);
      } catch {
        enqueueFinishSession(examSessionRef.current);
      }
    }
    // R9 — show the "sealed" closure beat first; it advances to break/done.
    setPhase({ kind: "sealed", finishedI: i, isLast });
  }

  /** Advance out of the sealed beat into the break (or the done ceremony). */
  function afterSealed(finishedI: number, isLast: boolean) {
    if (isLast) setPhase({ kind: "done" });
    else setPhase({ kind: "break", nextI: finishedI + 1 });
  }

  function requestFinish(i: number, expired: boolean) {
    setFinishIndex(i);
    setTimeExpired(expired);
    setShowFinish(true);
  }

  if (isLoading) return <LoadingState label="Loading exam…" />;
  if (isError || !detail)
    return (
      <div className="p-8">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );

  if (phase.kind === "intro") {
    return (
      <ExamShell>
        <Ceremony
          eyebrow="Full timed exam"
          title={detail.name}
          counsel={`${sections.length} sections, with a break between each. No scores or answers until blind review.`}
          aside={
            <ul className="mx-auto flex max-w-sm flex-col gap-1.5 text-left text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-1 w-1 rounded-full bg-primary" />
                Flag questions you want to revisit
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-1 w-1 rounded-full bg-primary" />
                Press <kbd className="rounded border px-1 font-mono text-xs">?</kbd> for shortcuts
              </li>
            </ul>
          }
          actions={
            <>
              <Button size="lg" onClick={() => void startExam()}>
                <PlayCircle className="h-4 w-4" /> Begin Section 1
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT))}
              >
                <Keyboard className="h-4 w-4" />
                Keyboard map
              </Button>
            </>
          }
          footer={
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => navigate("/practice")}
            >
              Cancel
            </button>
          }
        >
          <SectionItinerary sections={sections} />
        </Ceremony>
      </ExamShell>
    );
  }

  if (phase.kind === "sealed") {
    const order = sections[phase.finishedI]?.order ?? phase.finishedI + 1;
    return (
      <ExamShell>
        <SealedBeat
          label={phase.isLast ? "Exam sealed" : `Section ${order} sealed`}
          onDone={() => afterSealed(phase.finishedI, phase.isLast)}
        />
      </ExamShell>
    );
  }

  if (phase.kind === "done") {
    const lastIdx = sections.length - 1;
    const lastSid = examSessionId ?? sessionIds[lastIdx];
    return (
      <ExamShell>
        <PostExamHub
          examName={detail.name}
          sections={sections}
          sessionIds={sessionIds}
          examSessionId={examSessionId}
          onBlindReview={() =>
            navigate(lastSid != null ? `/blind-review/${lastSid}` : "/blind-review/0")
          }
        />
      </ExamShell>
    );
  }

  if (phase.kind === "break") {
    const breakSec = getAccommodations().breakMin * 60;
    const finishedI = phase.nextI - 1;
    const finishedStates = states[finishedI] ?? {};
    const finishedSection = loaded[finishedI];
    const qCount = finishedSection?.questions.length ?? 0;
    let answered = 0;
    let flagged = 0;
    let timeSum = 0;
    const perQuestionSec: number[] = [];
    for (let qi = 0; qi < qCount; qi++) {
      const st = finishedStates[qi] ?? blankState();
      if (st.answer) answered++;
      if (st.flagged) flagged++;
      timeSum += st.timeMs;
      perQuestionSec.push(Math.round(st.timeMs / 1000));
    }
    const avgTimeMs = qCount > 0 ? timeSum / qCount : 0;
    return (
      <BreakScreen
        breakSec={breakSec}
        nextSection={sections[phase.nextI]}
        interstitial={
          finishedSection ? (
            <SectionInterstitial
              answered={answered}
              total={qCount}
              flagged={flagged}
              avgTimeMs={avgTimeMs}
              timeLimitSec={finishedSection.time_limit_sec}
              perQuestionSec={perQuestionSec}
            />
          ) : null
        }
        onContinue={() => startSection(phase.nextI)}
        onSkip={() => startSection(phase.nextI)}
      />
    );
  }

  if (phase.kind === "section") {
    const sd = loaded[phase.i];
    if (loadingSection || !sd) return <LoadingState label="Loading section…" />;
    const sectionStates = states[phase.i] ?? {};
    const navItems: NavItem[] = sd.questions.map((q, qi) => {
      const st = sectionStates[qi] ?? blankState();
      return {
        answered: !!st.answer,
        flagged: st.flagged,
        hasEliminations: st.eliminated.size > 0,
        timeMs: st.timeMs,
        qType: q.q_type,
        previewText: (q.stem || q.prompt).slice(0, 80),
      };
    });

    return (
      <>
        <ExamProgressMap
          sections={sections}
          currentIndex={phase.i}
          completedThrough={completedThrough}
        />
        <SectionRunner
          key={phase.i}
          section={sd}
          draftKey={draftKeyForExamSection(sd.id)}
          states={sectionStates}
          setStates={(updater) =>
            setStates((prev) => ({
              ...prev,
              [phase.i]:
                typeof updater === "function"
                  ? (updater as (s: Record<number, QState>) => Record<number, QState>)(
                      prev[phase.i] ?? {},
                    )
                  : updater,
            }))
          }
          headerLabel={`${sd.type} · Section ${sections[phase.i]?.order ?? phase.i + 1} of ${sections.length}`}
          sampleBadge={data.usingSample}
          jumpToIndex={jumpToIndex}
          onJumpConsumed={() => setJumpToIndex(null)}
          finishLabel={
            phase.i >= sections.length - 1 ? "Finish exam" : "End section & break"
          }
          onFinish={(expired) => requestFinish(phase.i, expired)}
        />
        <Dialog open={showFinish} onOpenChange={setShowFinish}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {phase.i >= sections.length - 1 ? "Finish exam?" : "End this section?"}
              </DialogTitle>
              <DialogDescription>
                {timeExpired
                  ? "Time is up."
                  : `Review unanswered and flagged questions before continuing.`}
              </DialogDescription>
            </DialogHeader>
            <PreSubmitReview
              items={navItems}
              total={sd.questions.length}
              onJumpTo={(i) => {
                setShowFinish(false);
                setJumpToIndex(i);
              }}
            />
            <DialogFooter className="pt-2">
              {!timeExpired && (
                <Button variant="outline" onClick={() => setShowFinish(false)}>
                  Keep working
                </Button>
              )}
              <Button onClick={() => confirmFinishSection(finishIndex)}>
                {phase.i >= sections.length - 1 ? "Finish exam" : "End section"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return null;
}

function ExamShell({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col bg-background">{children}</div>;
}

function BreakScreen({
  breakSec,
  nextSection,
  interstitial,
  onContinue,
  onSkip,
}: {
  breakSec: number;
  nextSection?: SectionSummary;
  interstitial?: React.ReactNode;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [left, setLeft] = useState(breakSec);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (paused) return;
    timer.current = window.setInterval(() => {
      setLeft((t) => {
        if (t <= 1) {
          if (timer.current) window.clearInterval(timer.current);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [paused]);

  // Desktop notification when the break ends (no-op without permission).
  useEffect(() => {
    if (left === 0 && breakSec > 0) {
      void notify("Break over", "Time to start your next section.");
    }
  }, [left, breakSec]);

  return (
    <ExamShell>
      <Ceremony
        eyebrow="Intermission"
        title="Rest a moment"
        counsel="Stand, breathe, look away from the screen. Start the next section when you are ready."
        // The rest ring becomes the ceremony's focal glyph (replaces the brand mark).
        mark={false}
        glyph={<RestRing remaining={left} total={breakSec} paused={paused} />}
        aside={
          <div className="flex flex-col items-center gap-4">
            {nextSection && (
              <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
                <span className="type-overline">Up next</span>
                <Badge variant="secondary">{nextSection.type}</Badge>
                <span className="type-numeric">
                  Section {nextSection.order} · {formatClock(nextSection.time_limit_sec)}
                </span>
              </div>
            )}
            {interstitial}
          </div>
        }
        actions={
          <>
            <Button size="lg" onClick={onContinue}>
              <PlayCircle className="h-4 w-4" /> Start next section
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaused((p) => !p)}
              disabled={left === 0}
            >
              {paused ? "Resume timer" : "Pause timer"}
            </Button>
            <Button variant="outline" onClick={onSkip}>
              Skip break
            </Button>
          </>
        }
      />
    </ExamShell>
  );
}
