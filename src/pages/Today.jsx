import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox, RefreshCw, Sparkles, Target, TrendingUp } from 'lucide-react';
import { PageHeader, StatusBadge, Surface } from '../components/ui/Primitives';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { buildStudyPlan } from '../lib/studyDirector';
import { generateQuestionsFromCurriculum, getLlmSettings } from '../lib/localLlm';
import { getCfaSourceReadingForTopic } from '../lib/cfaSourceVault';

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
        if (active) setPlan(next);
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
            </>
          ) : null
        }
        actions={
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={16} /> {refreshing ? 'Refreshing…' : 'Refresh plan'}
          </button>
        }
      />

      {!plan ? (
        <Surface tone="study" density="compact">
          <p className="muted-copy" style={{ margin: 0 }}>Loading your plan…</p>
        </Surface>
      ) : (
        <>
          <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
            <p className="muted-copy" style={{ margin: 0 }}>{plan.headline}</p>
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

              {drill.questions.length > 0 && (
                <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {drill.questions.map((question, qi) => (
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
                      <ul style={{ margin: 'var(--space-2) 0', paddingLeft: 'var(--space-5)' }}>
                        {question.options.map((option, oi) => (
                          <li
                            key={oi}
                            style={{
                              color: oi === question.correct ? 'var(--success)' : 'var(--text-secondary)',
                              fontWeight: oi === question.correct ? 700 : 400,
                            }}
                          >
                            {option}
                            {oi === question.correct ? ' ✓' : ''}
                          </li>
                        ))}
                      </ul>
                      {question.explanation && (
                        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
                          {question.explanation}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Surface>
          )}
        </>
      )}
    </div>
  );
}
