import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingState, ErrorState } from "@lsat/components/states";
import { PostExamWizard } from "@lsat/components/exam/post-exam-wizard";
import { SealedBeat } from "@lsat/components/exam/sealed-beat";
import {
  SectionPresetsDialog,
  type SectionPreset,
} from "@lsat/components/exam/section-presets-dialog";
import { PreSubmitReview } from "@lsat/components/question/pre-submit-review";
import type { NavItem } from "@lsat/components/question/navigator-strip";
import {
  SectionRunner,
  blankState,
  type QState,
} from "@lsat/components/question/section-runner";
import { useDrillSession, useSection, useSessions } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import {
  enqueueFinishSession,
  enqueueSectionAttempts,
} from "@lsat/lib/offlineQueue";
import { attemptIdFor, clearAttemptIds } from "@lsat/lib/attemptIds";
import { playSectionEndBeep } from "@lsat/lib/examSounds";
import { setResume, clearResume } from "@lsat/lib/resume";
import { clearSessionDraft, draftKeyForSection } from "@lsat/lib/sessionDraft";
import type { AttemptCreateWire } from "@lsat/lib/apiTypes";

export default function TakeSection({
  sessionMode = false,
}: {
  // When true the route is /take/session/:sessionId — play a drill/smart-set's
  // curated question set (loaded from the existing StudySession) rather than a
  // Section. The questions come from GET /sessions/{id}/questions.
  sessionMode?: boolean;
}) {
  const params = useParams();
  const id = Number(sessionMode ? params.sessionId : params.sectionId);
  const navigate = useNavigate();
  // Only the active source fetches (the other is disabled via id=0).
  const sectionQuery = useSection(sessionMode ? 0 : id);
  const drillQuery = useDrillSession(sessionMode ? id : 0);
  const { data, isLoading, isError, error, refetch } = sessionMode
    ? drillQuery
    : sectionQuery;
  const sessions = useSessions();
  const lastFinishedSession = (sessions.data?.data ?? []).find(
    (s) => s.ended != null || s.scaled_score != null,
  );

  const section = data?.data;
  const questions = useMemo(() => section?.questions ?? [], [section]);

  const [states, setStates] = useState<Record<number, QState>>({});
  const [showFinish, setShowFinish] = useState(false);
  // R9 — a brief "sealed" closure beat between finishing and the post-section wizard.
  const [sealed, setSealed] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [timeExpired, setTimeExpired] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [jumpToIndex, setJumpToIndex] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const skipPreset = searchParams.get("preset") === "skip";
  const [preset, setPreset] = useState<SectionPreset | null>(
    skipPreset ? "timed" : null,
  );
  const [timedMode, setTimedMode] = useState(true);

  useEffect(() => {
    if (!section) return;
    // In session-mode the drill/smart-set StudySession already exists — attach to
    // it so attempts/finish land on it (creating a new section session would
    // orphan them). Otherwise create a fresh section session as before.
    if (sessionMode) {
      setSessionId(id);
      return;
    }
    let cancelled = false;
    api
      .createSession("section", { section_id: section.id })
      .then((s) => !cancelled && setSessionId(s.id))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [section, sessionMode, id]);

  if (isLoading) return <LoadingState label="Loading section…" />;
  if (isError || !section)
    return (
      <div className="p-8">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );

  const answeredCount = Object.values(states).filter((s) => s.answer).length;

  const navItems: NavItem[] = questions.map((_, i) => {
    const st = states[i] ?? blankState();
    return {
      answered: !!st.answer,
      flagged: st.flagged,
      hasEliminations: st.eliminated.size > 0,
      timeMs: st.timeMs,
      qType: questions[i]?.q_type,
      previewText: (questions[i]?.stem || questions[i]?.prompt || "").slice(0, 80),
    };
  });

  async function persistSession() {
    if (sessionId == null) return;
    const scope = draftKeyForSection(id);
    // 5.2 — each attempt carries a stable client_attempt_id (idempotency) and
    // 1.2 — the captured process-of-elimination trace. The id is keyed by
    // (scope, question) so an offline replay reuses it and never duplicates.
    const attempts: AttemptCreateWire[] = questions.map((q, i) => {
      const st = states[i] ?? blankState();
      return {
        question_id: q.id,
        mode: "timed",
        chosen_answer: st.answer,
        time_ms: Math.round(st.timeMs),
        flagged: st.flagged,
        choice_events: st.choiceEvents,
        client_attempt_id: attemptIdFor(scope, q.id),
      };
    });
    try {
      // 5.2 — ONE batch request instead of a serial per-question POST loop.
      await api.createAttemptsBatch(sessionId, attempts);
      await api.finishSession(sessionId);
    } catch {
      enqueueSectionAttempts(sessionId, attempts);
      enqueueFinishSession(sessionId);
    }
    // 1.5 — the section is submitted; drop the crash-safe draft + id map.
    clearSessionDraft(scope);
    clearAttemptIds(scope);
  }

  function startBlindReview() {
    clearResume();
    if (sessionId != null) navigate(`/blind-review/${sessionId}`);
    else navigate("/blind-review/0");
  }

  function applyPreset(p: SectionPreset) {
    if (p === "br_flagged") {
      const sid = lastFinishedSession?.id ?? sessionId;
      if (sid != null) {
        navigate(`/blind-review/${sid}?filter=flagged`);
      }
      return;
    }
    setPreset(p);
    setTimedMode(p === "timed");
  }

  if (preset == null && section) {
    return (
      <SectionPresetsDialog
        open
        timeLimitSec={section.time_limit_sec}
        hasPriorSession={lastFinishedSession != null || sessionId != null}
        onSelect={applyPreset}
      />
    );
  }

  if (sealed) {
    return (
      <div className="flex h-full flex-col bg-background">
        <SealedBeat
          label="Section sealed"
          onDone={() => {
            setSealed(false);
            setShowWizard(true);
          }}
        />
      </div>
    );
  }

  if (showWizard) {
    return (
      <PostExamWizard
        title="Section complete"
        sessionId={sessionId}
        sections={[
          {
            id: section.id,
            type: section.type,
            order: 1,
            question_count: questions.length,
            time_limit_sec: section.time_limit_sec,
          },
        ]}
        onBlindReview={startBlindReview}
        onDone={() => navigate("/practice")}
      />
    );
  }

  const resumePath = sessionMode ? `/take/session/${id}` : `/take/${id}`;

  return (
    <>
      <SectionRunner
        section={section}
        states={states}
        setStates={setStates}
        headerLabel={`${section.type} · Section`}
        sampleBadge={data.usingSample}
        draftKey={draftKeyForSection(id)}
        resumePath={resumePath}
        resumeLabel={`${section.type} section`}
        jumpToIndex={jumpToIndex}
        onJumpConsumed={() => setJumpToIndex(null)}
        timed={timedMode}
        onFinish={(expired) => {
          setTimeExpired(expired && timedMode);
          setShowFinish(true);
        }}
      />

      <Dialog open={showFinish} onOpenChange={setShowFinish}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {timedMode ? "Finish the timed section?" : "Finish this section?"}
            </DialogTitle>
            <DialogDescription>
              {timeExpired
                ? "Time is up."
                : `You answered ${answeredCount} of ${questions.length}.`}{" "}
              Next: blind review, then your review queue.
            </DialogDescription>
          </DialogHeader>
          <PreSubmitReview
            items={navItems}
            total={questions.length}
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
            <Button
              onClick={async () => {
                setShowFinish(false);
                playSectionEndBeep();
                await persistSession();
                setResume({
                  kind: "blind-review",
                  label: "Blind review in progress",
                  path: sessionId != null ? `/blind-review/${sessionId}` : "/review",
                  updatedAt: new Date().toISOString(),
                });
                // R9 — play the sealed beat, which then opens the wizard.
                setSealed(true);
              }}
            >
              Finish & review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
