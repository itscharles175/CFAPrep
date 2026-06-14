import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox, RefreshCw, Sparkles, Target, TrendingUp } from 'lucide-react';
import { PageHeader, StatusBadge, Surface } from '../components/ui/Primitives';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { buildStudyPlan } from '../lib/studyDirector';
import type { StudyAction, StudyPlan } from '../lib/studyDirector';
import { generateQuestionsFromCurriculum, getLlmSettings, narrateStudyPlan } from '../lib/localLlm';
import { getCfaSourceReadingForTopic } from '../lib/cfaSourceVault';
import { db } from '../lib/progressStore';
import { getStorage } from '../lib/storage';

interface TopicPath {
  level: string;
  topic: string;
}

// Parse a /cfa/<level>/<topic> path produced by buildStudyPlan into its
// level + topic ids. Returns null for paths that don't fit the shape.
function parseTopicPath(path: string | undefined): TopicPath | null {
  const match = /^\/cfa\/(level[1-3])\/([^/?#]+)/.exec(path || '');
  return match ? { level: match[1], topic: match[2] } : null;
}

// Focused-mode landing: one screen, one decision — "do this next."
// Pulls from the same buildStudyPlan() that powers the Study Director panel
// on the CFA dashboard, but blows up the top action into a hero card and
// stacks the rest below. Pure read-only; no actions besides Link navigation.

type Tone = 'warning' | 'danger' | 'exam' | 'success' | 'accent';

function toneForKind(kind: StudyAction['kind']): Tone {
  if (kind === 'review') return 'warning';
  if (kind === 'weak-topic') return 'danger';
  if (kind === 'forecast-spike') return 'exam';
  return 'success';
}

interface ActionIconRenderProps {
  kind: StudyAction['kind'];
  size: number;
}

function ActionIconRender({ kind, size }: ActionIconRenderProps) {
  // Inline per-kind JSX rather than `const Icon = iconForKind(kind)` so the
  // react-hooks/static-components lint stays happy (it flags any computed
  // component reference as "created during render").
  if (kind === 'review') return <Inbox size={size} />;
  if (kind === 'weak-topic') return <Target size={size} />;
  if (kind === 'forecast-spike') return <TrendingUp size={size} />;
  return <ChevronRight size={size} />;
}

interface AiQuestion {
  id: string;
  question: string;
  options: string[];
  correct: number;
  explanation: string;
}

// UB3: animates a number from 0 up to `value` once, ~600ms, easing out.
// Respects prefers-reduced-motion (renders the final value immediately).
// Purely cosmetic — the `value` passed in is the already-correct score.
function ScoreCountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced || value <= 0) {
      setShown(value);
      return undefined;
    }
    setShown(0);
    const durationMs = 600;
    const start =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic for a settled finish
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(eased * value));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{shown}</>;
}

type DrillState =
  | { state: 'idle'; questions: AiQuestion[]; error: '' }
  | { state: 'loading'; questions: AiQuestion[]; error: '' }
  | { state: 'done'; questions: AiQuestion[]; error: '' }
  | { state: 'error'; questions: AiQuestion[]; error: string };

type NarrativeState =
  | { state: 'idle'; text: ''; error: '' }
  | { state: 'loading'; text: ''; error: '' }
  | { state: 'done'; text: string; error: '' }
  | { state: 'error'; text: ''; error: string };

interface ExamCountdown {
  days: number;
  date: string;
}

interface JournalState {
  text: string;
  savedAt: string | null;
  dirty: boolean;
}

type TimerState =
  | { state: 'idle'; startedAt: null; accumulatedMs: number }
  | { state: 'running'; startedAt: number; accumulatedMs: number }
  | { state: 'paused'; startedAt: null; accumulatedMs: number };

interface JournalRowValue {
  text?: string;
  savedAt?: string | null;
}

export default function Today() {
  const [activePathway] = useLevel3Pathway() as [string, (next: string) => void];
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Targeted drill state — generates AI MCQs for the weakest topic on demand.
  const [drill, setDrill] = useState<DrillState>({ state: 'idle', questions: [], error: '' });
  // Map of question.id -> selected option index. Empty until the user picks.
  const [drillAnswers, setDrillAnswers] = useState<Record<string, number>>({});
  const [narrative, setNarrative] = useState<NarrativeState>({ state: 'idle', text: '', error: '' });
  const [examCountdown, setExamCountdown] = useState<ExamCountdown | null>(null);
  const [journal, setJournal] = useState<JournalState>({ text: '', savedAt: null, dirty: false });
  const journalKey = `journal:${new Date().toISOString().slice(0, 10)}`;

  useEffect(() => {
    let active = true;
    getStorage().settings.get(journalKey).then((row) => {
      const value = (row as { value?: JournalRowValue } | undefined)?.value;
      if (active && value) {
        setJournal({ text: value.text || '', savedAt: value.savedAt || null, dirty: false });
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveJournal() {
    const text = journal.text;
    const stamp = new Date().toISOString();
    await getStorage().settings.put({ key: journalKey, value: { text, savedAt: stamp }, updatedAt: stamp });
    setJournal({ text, savedAt: stamp, dirty: false });
  }
  // Pomodoro-style study session timer.
  const [timer, setTimer] = useState<TimerState>({ state: 'idle', startedAt: null, accumulatedMs: 0 });
  const [displaySeconds, setDisplaySeconds] = useState(0);

  useEffect(() => {
    function update() {
      const nowMs = Date.now();
      const segment = timer.state === 'running' && timer.startedAt ? nowMs - timer.startedAt : 0;
      setDisplaySeconds(Math.floor((timer.accumulatedMs + segment) / 1000));
    }
    update();
    if (timer.state !== 'running') return undefined;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [timer.state, timer.startedAt, timer.accumulatedMs]);

  function startTimer() {
    setTimer((prev) => ({ state: 'running', startedAt: Date.now(), accumulatedMs: prev.accumulatedMs }));
  }
  function pauseTimer() {
    setTimer((prev) => {
      if (prev.state !== 'running' || !prev.startedAt) return prev;
      const segment = Date.now() - prev.startedAt;
      return { state: 'paused', startedAt: null, accumulatedMs: prev.accumulatedMs + segment };
    });
  }
  async function stopTimer() {
    const snapshot = timer;
    const totalMs = snapshot.state === 'running' && snapshot.startedAt
      ? snapshot.accumulatedMs + (Date.now() - snapshot.startedAt)
      : snapshot.accumulatedMs;
    const elapsedSeconds = Math.floor(totalMs / 1000);
    if (elapsedSeconds > 5) {
      const now = new Date();
      const started = new Date(now.getTime() - totalMs);
      try {
        await db.studySessions.add({
          domain: 'cfa',
          topic: weakAction ? `cfa:${weakTopic?.topic || 'today'}` : 'cfa:today',
          mode: 'focus-timer',
          startedAt: started.toISOString(),
          endedAt: now.toISOString(),
          elapsedSeconds,
          questionsAnswered: drill.questions.length,
          score: drill.questions.length
            ? drill.questions.filter((q) => drillAnswers[q.id] === q.correct).length
            : 0,
        });
      } catch {
        // best-effort persistence; not blocking
      }
    }
    setTimer({ state: 'idle', startedAt: null, accumulatedMs: 0 });
  }

  function formatTimer(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  useEffect(() => {
    let active = true;
    getStorage().settings.get('exam-date').then((row) => {
      const value = (row as { value?: string } | undefined)?.value;
      if (!active || !value) return;
      const target = new Date(value);
      if (Number.isNaN(target.getTime())) return;
      const diffMs = target.getTime() - Date.now();
      const days = Math.ceil(diffMs / 86400000);
      setExamCountdown({ days, date: value });
    });
    return () => {
      active = false;
    };
  }, []);

  async function generateNarrative() {
    if (!plan) return;
    setNarrative({ state: 'loading', text: '', error: '' });
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setNarrative({ state: 'error', text: '', error: 'Enable a local model in System Health → Local AI first.' });
        return;
      }
      const text = await narrateStudyPlan({ settings, plan, signal: undefined });
      setNarrative({ state: 'done', text, error: '' });
    } catch (error) {
      setNarrative({
        state: 'error',
        text: '',
        error: error instanceof Error ? error.message : 'Narrative generation failed.',
      });
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const next = await buildStudyPlan({ pathway: activePathway });
      setPlan(next);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let active = true;
    buildStudyPlan({ pathway: activePathway })
      .then((next) => {
        if (!active) return;
        setPlan(next);
        // Best-effort browser reminder: if the user granted permission and has
        // due reviews today, ping them once per day. Idempotent via a
        // localStorage marker so reloading /today doesn't re-fire it.
        try {
          if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            next?.dueCount > 0
          ) {
            const today = new Date().toISOString().slice(0, 10);
            const marker = `qv-reminder-${today}`;
            if (typeof localStorage !== 'undefined' && localStorage.getItem(marker) !== '1') {
              localStorage.setItem(marker, '1');
              new Notification('StudyVault — reviews due', {
                body: `${next.dueCount} review${next.dueCount === 1 ? '' : 's'} ready in your inbox.`,
                tag: marker,
              });
            }
          }
        } catch {
          // notifications are best-effort
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [activePathway]);

  // First weak-topic action, used by the targeted-drill panel.
  const weakAction = plan?.actions?.find((a) => a.kind === 'weak-topic');
  const weakTopic = weakAction ? parseTopicPath(weakAction.path) : null;

  async function generateDrill() {
    if (!weakTopic || !weakAction) return;
    setDrill({ state: 'loading', questions: [], error: '' });
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setDrill({ state: 'error', questions: [], error: 'Enable a local model in System Health → Local AI first.' });
        return;
      }
      const reading = await getCfaSourceReadingForTopic(weakTopic.level, weakTopic.topic);
      if (!reading.chunks?.length) {
        setDrill({
          state: 'error',
          questions: [],
          error: 'No ingested curriculum for this topic yet — import a .qvsource bundle or pick a folder of PDFs in System Health to ground the drill.',
        });
        return;
      }
      const questions = await generateQuestionsFromCurriculum({
        settings,
        topicTitle: weakAction.title,
        chunks: reading.chunks.slice(0, 14),
        count: 3,
        signal: undefined,
      });
      setDrill({ state: 'done', questions, error: '' });
      setDrillAnswers({});
    } catch (error) {
      setDrill({
        state: 'error',
        questions: [],
        error: error instanceof Error ? error.message : 'Drill generation failed.',
      });
    }
  }

  const top = plan?.actions?.[0];
  const rest = (plan?.actions || []).slice(1, 5);

  return (
    <div className="page-container">
      <PageHeader
        tone="study"
        badge="TODAY"
        title="What to study right now"
        subtitle="One screen, one decision. Prioritized from your local FSRS queue, topic readiness, and upcoming review load."
        meta={
          plan ? (
            <>
              <StatusBadge tone="warning">{plan.dueCount} review{plan.dueCount === 1 ? '' : 's'} due</StatusBadge>
              <StatusBadge tone="danger">{plan.weakCount} weak topic{plan.weakCount === 1 ? '' : 's'}</StatusBadge>
              {plan.peakReviewDay && <StatusBadge tone="exam">Peak {plan.peakReviewDay.date} · {plan.peakReviewDay.count}</StatusBadge>}
              {examCountdown && (
                <StatusBadge tone={examCountdown.days < 14 ? 'danger' : examCountdown.days < 60 ? 'warning' : 'exam'}>
                  {examCountdown.days <= 0
                    ? `Exam ${examCountdown.days === 0 ? 'today' : `${-examCountdown.days}d ago`}`
                    : `${examCountdown.days}d to exam`}
                </StatusBadge>
              )}
            </>
          ) : null
        }
        actions={
          <div className="qv-row-2">
            <div
              className="today-timer-pill"
              style={{
                display: 'flex',
                gap: 'var(--space-1)',
                alignItems: 'center',
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--border)',
                fontFamily: 'var(--font-mono, monospace)',
                minWidth: 110,
                justifyContent: 'center',
              }}
              title="Study session timer — counts elapsed focus time; persists to studySessions on Stop"
            >
              <span className="qv-fw-semibold">{formatTimer(displaySeconds)}</span>
              {timer.state === 'idle' && (
                <button className="btn-icon btn-ghost" onClick={startTimer} aria-label="Start study timer">▶</button>
              )}
              {timer.state === 'running' && (
                <>
                  <button className="btn-icon btn-ghost" onClick={pauseTimer} aria-label="Pause study timer">⏸</button>
                  <button className="btn-icon btn-ghost" onClick={stopTimer} aria-label="Stop study timer">⏹</button>
                </>
              )}
              {timer.state === 'paused' && (
                <>
                  <button className="btn-icon btn-ghost" onClick={startTimer} aria-label="Resume study timer">▶</button>
                  <button className="btn-icon btn-ghost" onClick={stopTimer} aria-label="Stop study timer">⏹</button>
                </>
              )}
            </div>
            <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={16} /> {refreshing ? 'Refreshing…' : 'Refresh plan'}
            </button>
          </div>
        }
      />

      {!plan ? (
        <Surface tone="study" density="compact">
          <p className="muted-copy qv-m-0">Loading your plan…</p>
        </Surface>
      ) : (
        <>
          <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="flex-between qv-row-3">
              <p className="muted-copy qv-m-0">{plan.headline}</p>
              <button
                className="btn btn-secondary btn-sm"
                onClick={generateNarrative}
                disabled={narrative.state === 'loading'}
                title="Generate a personalized rationale for today's plan via your local model"
              >
                {narrative.state === 'loading' ? 'Thinking…' : narrative.text ? 'Regenerate narrative' : '🤖 Why this plan today'}
              </button>
            </div>

            {narrative.state === 'done' && narrative.text && (
              <p
                className="qv-callout qv-mt-3"
                style={{ whiteSpace: 'pre-line' }}
              >
                {narrative.text}
              </p>
            )}
            {narrative.state === 'error' && (
              <p className="qv-text-danger qv-fs-sm qv-mt-2">
                {narrative.error}
              </p>
            )}
            {top && (
              <Link
                to={top.path}
                className="qv-card-lg"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  marginTop: 'var(--space-4)',
                  background: 'var(--surface-2, rgba(120, 180, 255, 0.06))',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span style={{ flexShrink: 0, opacity: 0.85, display: 'inline-flex' }}>
                  <ActionIconRender kind={top.kind} size={40} />
                </span>
                <div style={{ flex: 1 }}>
                  <StatusBadge tone={toneForKind(top.kind)}>{top.kind.replace('-', ' ')}</StatusBadge>
                  <h2 style={{ margin: 'var(--space-2) 0 var(--space-1)' }}>{top.title}</h2>
                  <p className="muted-copy qv-m-0">{top.reason}</p>
                </div>
                <ChevronRight size={28} style={{ flexShrink: 0 }} />
              </Link>
            )}
          </Surface>

          {rest.length > 0 && (
            <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-6)' }}>
              <StatusBadge tone="accent">Then</StatusBadge>
              <ul className="qv-stack-2 qv-mt-3" style={{ listStyle: 'none', padding: 0, marginBottom: 0 }}>
                {rest.map((action, index) => (
                  <li key={`${action.kind}-${index}`}>
                    <Link
                      to={action.path}
                      className="flex-between qv-card"
                      style={{
                        gap: 'var(--space-3)',
                        alignItems: 'center',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <span className="qv-row-3">
                        <ActionIconRender kind={action.kind} size={18} />
                        <span>
                          <strong style={{ display: 'block' }}>{action.title}</strong>
                          <small className="muted-copy">{action.reason}</small>
                        </span>
                      </span>
                      <StatusBadge tone={toneForKind(action.kind)}>{action.kind.replace('-', ' ')}</StatusBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            </Surface>
          )}

          {weakAction && (
            <Surface tone="study" status="warning" style={{ marginBottom: 'var(--space-6)' }}>
              <div className="flex-between qv-row-3-start">
                <div>
                  <StatusBadge tone="warning"><Sparkles size={14} /> Drill your weakest topic</StatusBadge>
                  <h3 className="qv-mt-2" style={{ marginBottom: 0 }}>{weakAction.title}</h3>
                  <p className="muted-copy qv-mt-1" style={{ marginBottom: 0 }}>{weakAction.reason}</p>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={generateDrill}
                  disabled={drill.state === 'loading' || !weakTopic}
                  title={weakTopic ? 'Generate 3 grounded MCQs via the local LLM' : 'Topic path could not be parsed'}
                >
                  {drill.state === 'loading' ? 'Generating…' : drill.questions.length ? 'Regenerate drill' : 'Generate drill'}
                </button>
              </div>

              {drill.state === 'error' && (
                <p className="qv-text-danger qv-mt-2" style={{ marginBottom: 0 }}>{drill.error}</p>
              )}

              {drill.questions.length > 0 && (() => {
                const total = drill.questions.length;
                const answered = drill.questions.filter((q) => drillAnswers[q.id] != null).length;
                const correct = drill.questions.filter(
                  (q) => drillAnswers[q.id] === q.correct,
                ).length;
                return (
                  <div className="qv-stack-3 qv-mt-3">
                    {answered === total && (
                      <p className="muted-copy qv-m-0 drill-explanation">
                        Score:{' '}
                        <strong className="qv-text-success">
                          <ScoreCountUp value={correct} />
                        </strong>
                        {' / '}
                        {total}
                      </p>
                    )}
                    {drill.questions.map((question, qi) => {
                      const picked = drillAnswers[question.id];
                      const isAnswered = picked != null;
                      return (
                        <div
                          key={question.id}
                          className="qv-card"
                        >
                          <strong>
                            {qi + 1}. {question.question}
                          </strong>
                          <div className="qv-stack-1" style={{ margin: 'var(--space-2) 0' }}>
                            {question.options.map((option, oi) => {
                              let bg = 'transparent';
                              let color = 'inherit';
                              let weight = 400;
                              // UB3: cosmetic per-option feedback class. drill-correct
                              // pulses a success glow on the right answer; drill-incorrect
                              // shakes the wrongly-picked option. Both are gated by
                              // prefers-reduced-motion in index.css.
                              let feedbackClass = '';
                              if (isAnswered) {
                                if (oi === question.correct) {
                                  bg = 'rgba(52, 211, 153, 0.12)';
                                  color = 'var(--success)';
                                  weight = 700;
                                  feedbackClass = ' drill-correct';
                                } else if (oi === picked) {
                                  bg = 'rgba(239, 68, 68, 0.12)';
                                  color = 'var(--danger)';
                                  feedbackClass = ' drill-incorrect';
                                }
                              } else if (oi === picked) {
                                bg = 'var(--accent-soft, rgba(96,165,250,0.18))';
                              }
                              return (
                                <button
                                  key={oi}
                                  type="button"
                                  className={`drill-option${feedbackClass}`}
                                  onClick={() =>
                                    setDrillAnswers((prev) =>
                                      prev[question.id] != null ? prev : { ...prev, [question.id]: oi },
                                    )
                                  }
                                  disabled={isAnswered}
                                  style={{
                                    textAlign: 'left',
                                    padding: 'var(--space-2) var(--space-3)',
                                    borderRadius: 'var(--radius-sm, 6px)',
                                    border: '1px solid var(--border)',
                                    background: bg,
                                    color,
                                    fontWeight: weight,
                                    cursor: isAnswered ? 'default' : 'pointer',
                                  }}
                                >
                                  {String.fromCharCode(65 + oi)}. {option}
                                  {isAnswered && oi === question.correct ? ' ✓' : ''}
                                  {isAnswered && oi === picked && oi !== question.correct ? ' ✗' : ''}
                                </button>
                              );
                            })}
                          </div>
                          {isAnswered && question.explanation && (
                            <p className="qv-text-muted qv-fs-sm qv-m-0 drill-explanation">
                              {question.explanation}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </Surface>
          )}

          <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="flex-between qv-row-3-start">
              <div>
                <StatusBadge tone="accent">Daily journal</StatusBadge>
                <p className="muted-copy qv-mt-1" style={{ marginBottom: 0 }}>
                  One-paragraph reflection on today's study session. Stays in your local vault, per-date.
                </p>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={saveJournal}
                disabled={!journal.dirty}
                title={journal.savedAt ? `Last saved ${new Date(journal.savedAt).toLocaleTimeString()}` : 'Save'}
              >
                {journal.dirty ? 'Save' : journal.savedAt ? 'Saved' : 'Save'}
              </button>
            </div>
            <textarea
              className="input qv-mt-2"
              rows={4}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="What did I work on? What clicked? What still feels shaky? What is the smallest next step?"
              value={journal.text}
              onChange={(event) => setJournal((prev) => ({ ...prev, text: event.target.value, dirty: true }))}
              onBlur={() => {
                if (journal.dirty) saveJournal();
              }}
            />
          </Surface>
        </>
      )}
    </div>
  );
}
