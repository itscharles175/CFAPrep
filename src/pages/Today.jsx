import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox, RefreshCw, Sparkles, Target, TrendingUp } from 'lucide-react';
import { PageHeader, StatusBadge, Surface } from '../components/ui/Primitives';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { buildStudyPlan } from '../lib/studyDirector';
import { generateQuestionsFromCurriculum, getLlmSettings, narrateStudyPlan } from '../lib/localLlm';
import { getCfaSourceReadingForTopic } from '../lib/cfaSourceVault';
import { db } from '../lib/progressStore';

// Parse a /cfa/<level>/<topic> path produced by buildStudyPlan into its
// level + topic ids. Returns null for paths that don't fit the shape.
function parseTopicPath(path) {
  const match = /^\/cfa\/(level[1-3])\/([^/?#]+)/.exec(path || '');
  return match ? { level: match[1], topic: match[2] } : null;
}

// Focused-mode landing: one screen, one decision — "do this next."
// Pulls from the same buildStudyPlan() that powers the Study Director panel
// on the CFA dashboard, but blows up the top action into a hero card and
// stacks the rest below. Pure read-only; no actions besides Link navigation.

function toneForKind(kind) {
  if (kind === 'review') return 'warning';
  if (kind === 'weak-topic') return 'danger';
  if (kind === 'forecast-spike') return 'exam';
  return 'success';
}

function ActionIconRender({ kind, size }) {
  // Inline per-kind JSX rather than `const Icon = iconForKind(kind)` so the
  // react-hooks/static-components lint stays happy (it flags any computed
  // component reference as "created during render").
  if (kind === 'review') return <Inbox size={size} />;
  if (kind === 'weak-topic') return <Target size={size} />;
  if (kind === 'forecast-spike') return <TrendingUp size={size} />;
  return <ChevronRight size={size} />;
}

export default function Today() {
  const [activePathway] = useLevel3Pathway();
  const [plan, setPlan] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Targeted drill state — generates AI MCQs for the weakest topic on demand.
  const [drill, setDrill] = useState({ state: 'idle', questions: [], error: '' });
  // Map of question.id -> selected option index. Empty until the user picks.
  const [drillAnswers, setDrillAnswers] = useState({});
  const [narrative, setNarrative] = useState({ state: 'idle', text: '', error: '' });
  const [examCountdown, setExamCountdown] = useState(null);
  // Pomodoro-style study session timer.
  const [timer, setTimer] = useState({ state: 'idle', startedAt: null, accumulatedMs: 0 });
  const [displaySeconds, setDisplaySeconds] = useState(0);

  useEffect(() => {
    function recompute() {
      const running = timer.state === 'running' && timer.startedAt
        ? performance.now() + (Date.now() - performance.now()) // dummy to avoid impure-Date inside render
        : 0;
      void running;
    }
    void recompute;
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

  function formatTimer(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  useEffect(() => {
    let active = true;
    db.settings.get('exam-date').then((row) => {
      if (!active || !row?.value) return;
      const target = new Date(row.value);
      if (Number.isNaN(target.getTime())) return;
      const diffMs = target.getTime() - Date.now();
      const days = Math.ceil(diffMs / 86400000);
      setExamCountdown({ days, date: row.value });
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
      const text = await narrateStudyPlan({ settings, plan });
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
              new Notification('QuantVault — reviews due', {
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
    if (!weakTopic) return;
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
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <div
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
              <span style={{ fontWeight: 600 }}>{formatTimer(displaySeconds)}</span>
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
          <p className="muted-copy" style={{ margin: 0 }}>Loading your plan…</p>
        </Surface>
      ) : (
        <>
          <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
              <p className="muted-copy" style={{ margin: 0 }}>{plan.headline}</p>
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
                style={{
                  marginTop: 'var(--space-3)',
                  padding: 'var(--space-3)',
                  borderLeft: '3px solid var(--accent)',
                  background: 'var(--surface-2, rgba(120,180,255,0.06))',
                  borderRadius: 'var(--radius-md, 8px)',
                  whiteSpace: 'pre-line',
                  lineHeight: 1.55,
                }}
              >
                {narrative.text}
              </p>
            )}
            {narrative.state === 'error' && (
              <p style={{ color: 'var(--danger)', marginTop: 'var(--space-2)', fontSize: 'var(--fs-sm)' }}>
                {narrative.error}
              </p>
            )}
            {top && (
              <Link
                to={top.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  marginTop: 'var(--space-4)',
                  padding: 'var(--space-5)',
                  borderRadius: 'var(--radius-lg, 12px)',
                  border: '1px solid var(--border)',
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
                  <p className="muted-copy" style={{ margin: 0 }}>{top.reason}</p>
                </div>
                <ChevronRight size={28} style={{ flexShrink: 0 }} />
              </Link>
            )}
          </Surface>

          {rest.length > 0 && (
            <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-6)' }}>
              <StatusBadge tone="accent">Then</StatusBadge>
              <ul style={{ listStyle: 'none', margin: 'var(--space-3) 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {rest.map((action, index) => (
                  <li key={`${action.kind}-${index}`}>
                    <Link
                      to={action.path}
                      className="flex-between"
                      style={{
                        gap: 'var(--space-3)',
                        alignItems: 'center',
                        padding: 'var(--space-3)',
                        borderRadius: 'var(--radius-md, 8px)',
                        border: '1px solid var(--border)',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
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
              <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                <div>
                  <StatusBadge tone="warning"><Sparkles size={14} /> Drill your weakest topic</StatusBadge>
                  <h3 style={{ margin: 'var(--space-2) 0 0' }}>{weakAction.title}</h3>
                  <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>{weakAction.reason}</p>
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
                <p style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0' }}>{drill.error}</p>
              )}

              {drill.questions.length > 0 && (() => {
                const total = drill.questions.length;
                const answered = drill.questions.filter((q) => drillAnswers[q.id] != null).length;
                const correct = drill.questions.filter(
                  (q) => drillAnswers[q.id] === q.correct,
                ).length;
                return (
                  <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    {answered === total && (
                      <p className="muted-copy" style={{ margin: 0 }}>
                        Score: <strong style={{ color: 'var(--success)' }}>{correct}</strong>
                        {' / '}
                        {total}
                      </p>
                    )}
                    {drill.questions.map((question, qi) => {
                      const picked = drillAnswers[question.id];
                      const answered = picked != null;
                      return (
                        <div
                          key={question.id}
                          style={{
                            padding: 'var(--space-3)',
                            borderRadius: 'var(--radius-md, 8px)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <strong>
                            {qi + 1}. {question.question}
                          </strong>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', margin: 'var(--space-2) 0' }}>
                            {question.options.map((option, oi) => {
                              let bg = 'transparent';
                              let color = 'inherit';
                              let weight = 400;
                              if (answered) {
                                if (oi === question.correct) {
                                  bg = 'rgba(52, 211, 153, 0.12)';
                                  color = 'var(--success)';
                                  weight = 700;
                                } else if (oi === picked) {
                                  bg = 'rgba(239, 68, 68, 0.12)';
                                  color = 'var(--danger)';
                                }
                              } else if (oi === picked) {
                                bg = 'var(--accent-soft, rgba(96,165,250,0.18))';
                              }
                              return (
                                <button
                                  key={oi}
                                  type="button"
                                  onClick={() =>
                                    setDrillAnswers((prev) =>
                                      prev[question.id] != null ? prev : { ...prev, [question.id]: oi },
                                    )
                                  }
                                  disabled={answered}
                                  style={{
                                    textAlign: 'left',
                                    padding: 'var(--space-2) var(--space-3)',
                                    borderRadius: 'var(--radius-sm, 6px)',
                                    border: '1px solid var(--border)',
                                    background: bg,
                                    color,
                                    fontWeight: weight,
                                    cursor: answered ? 'default' : 'pointer',
                                  }}
                                >
                                  {String.fromCharCode(65 + oi)}. {option}
                                  {answered && oi === question.correct ? ' ✓' : ''}
                                  {answered && oi === picked && oi !== question.correct ? ' ✗' : ''}
                                </button>
                              );
                            })}
                          </div>
                          {answered && question.explanation && (
                            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
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
        </>
      )}
    </div>
  );
}
