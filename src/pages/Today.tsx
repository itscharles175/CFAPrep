import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Clock, Inbox, NotebookPen, RefreshCw, Sparkles, Target, TrendingUp } from 'lucide-react';
import { PageHeader, StatusBadge, Surface } from '../components/ui/Primitives';
import { Skeleton } from '../components/feedback';
import { OnboardingResume, useStudySession } from '../components/session';
import UnifiedPlanSection from '../components/today/UnifiedPlanSection';
import { useNextQuestions } from '../hooks/useNextQuestions';
import { AdaptiveRecommendationCard } from '../components/drills/AdaptiveRecommendationCard';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { buildStudyPlan } from '../lib/studyDirector';
import type { StudyAction, StudyPlan } from '../lib/studyDirector';
import { generateQuestionsFromCurriculum, getLlmSettings, narrateStudyPlan } from '../lib/localLlm';
import { getCfaSourceReadingForTopic } from '../lib/cfaSourceVault';
import { getStorage } from '../lib/storage';
import { useScrollRestoration } from '../lib/scrollRestore';
import { useStudyContext } from '../lib/studyContext';
import type { StudyDomain, StudyGoal } from '../lib/studyContext';

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

interface JournalRowValue {
  text?: string;
  savedAt?: string | null;
}

const DOMAIN_LABELS: Record<StudyDomain, string> = {
  cfa: 'CFA',
  lsat: 'LSAT',
  quant: 'Quant',
  excel: 'Excel',
};

const GOAL_LABELS: Record<StudyGoal, string> = {
  balanced: 'Balanced',
  'exam-readiness': 'Exam readiness',
  retention: 'Retention',
  'skill-building': 'Skill building',
};

function goalSubtitle(goal: StudyGoal): string {
  if (goal === 'exam-readiness') return 'Your next exam focused step, based on readiness and remaining time.';
  if (goal === 'retention') return 'Your next retention pass, based on memory strength and due work.';
  if (goal === 'skill-building') return 'Your next skill building step, based on productive practice value.';
  return 'Your highest-value next step, based on due work and current readiness.';
}

interface FallbackDomainConfig {
  title: string;
  path: string;
  followUpTitle: string;
  followUpPath: string;
  minutes: number;
  objective: string;
}

const FALLBACK_DOMAIN_CONFIG: Record<Exclude<StudyDomain, 'cfa'>, FallbackDomainConfig> = {
  lsat: {
    title: 'Practice an LSAT section',
    path: '/lsat/practice',
    followUpTitle: 'Review your LSAT work',
    followUpPath: '/lsat/review',
    minutes: 35,
    objective: 'lsat:section',
  },
  quant: {
    title: 'Continue Quant practice',
    path: '/quant',
    followUpTitle: 'Review Quant concepts',
    followUpPath: '/review',
    minutes: 30,
    objective: 'quant:practice',
  },
  excel: {
    title: 'Continue Excel practice',
    path: '/excel',
    followUpTitle: 'Review Excel concepts',
    followUpPath: '/review',
    minutes: 30,
    objective: 'excel:practice',
  },
};

export interface TodayWorkloadSummary {
  currentLabel: string | null;
  remainderLabel: string | null;
  totalLabel: string;
  activityCount: number;
  totalMinutes: number | null;
}

const WORKSPACE_ROOTS: Record<StudyDomain, string> = {
  cfa: '/cfa',
  lsat: '/lsat',
  quant: '/quant',
  excel: '/excel',
};

type TodaySessionStatus = 'none' | 'running' | 'paused' | 'saving' | 'save-error';

export function isTodayWorkspaceDestination(domain: StudyDomain, path: string): boolean {
  return path === WORKSPACE_ROOTS[domain];
}

export function todayPrimaryActionLabel({
  domain,
  path,
  sessionStatus,
  sessionDomain,
}: {
  domain: StudyDomain;
  path: string;
  sessionStatus: TodaySessionStatus;
  sessionDomain?: StudyDomain;
}): string {
  const sameDomain = sessionDomain === domain;
  if (sessionStatus === 'paused' && sameDomain) return 'Resume activity';
  if (sessionStatus === 'running' && sameDomain) return 'Continue activity';
  if (sessionStatus === 'save-error' && sameDomain) return 'Open activity';
  if (isTodayWorkspaceDestination(domain, path)) return `Open ${DOMAIN_LABELS[domain]} workspace`;
  return 'Start activity';
}

export function todayHeroTitle({
  domain,
  title,
  sessionStatus,
  sessionDomain,
}: {
  domain: StudyDomain;
  title: string;
  sessionStatus: TodaySessionStatus;
  sessionDomain?: StudyDomain;
}): string {
  if (sessionStatus !== 'paused' || sessionDomain !== domain) return title;
  return domain === 'lsat' ? 'Resume LSAT section' : `Resume ${DOMAIN_LABELS[domain]} session`;
}

function actionKindLabel(kind: StudyAction['kind']): string {
  if (kind === 'review') return 'review';
  if (kind === 'weak-topic') return 'focused practice';
  if (kind === 'forecast-spike') return 'review ahead';
  return 'study';
}

/**
 * Formats the ordered shortlist as now → remainder → total. Durations are
 * shown only when every relevant action carries a real estimate, so mocked or
 * partially populated plans never imply work that the plan did not schedule.
 */
export function summarizeTodayWorkload(plan: Pick<StudyPlan, 'actions'> | null | undefined): TodayWorkloadSummary {
  const actions = plan?.actions ?? [];
  const hasDuration = (action: StudyAction | undefined): action is StudyAction & { estimatedMinutes: number } =>
    Boolean(action && Number.isFinite(action.estimatedMinutes) && action.estimatedMinutes > 0);
  const current = actions[0];
  const remainder = actions.slice(1);
  const allDurationsKnown = actions.length > 0 && actions.every(hasDuration);
  const remainderDurationsKnown = remainder.length > 0 && remainder.every(hasDuration);
  const totalMinutes = allDurationsKnown
    ? actions.reduce((sum, action) => sum + action.estimatedMinutes, 0)
    : null;
  const remainderMinutes = remainderDurationsKnown
    ? remainder.reduce((sum, action) => sum + action.estimatedMinutes, 0)
    : 0;

  return {
    currentLabel: hasDuration(current) ? `About ${current.estimatedMinutes} min now` : null,
    remainderLabel: remainderDurationsKnown
      ? remainder.length === 1
        ? `Then ${remainderMinutes} min ${actionKindLabel(remainder[0].kind)}`
        : `Then ${remainderMinutes} min across ${remainder.length} more activities`
      : null,
    totalLabel: totalMinutes != null
      ? `${actions.length} ${actions.length === 1 ? 'activity' : 'activities'} · ${totalMinutes} min total`
      : `${actions.length} ${actions.length === 1 ? 'activity' : 'activities'}`,
    activityCount: actions.length,
    totalMinutes,
  };
}

/** Deterministic plan used when a non-CFA curriculum has no local planner yet. */
export function createDomainFallbackPlan(domain: Exclude<StudyDomain, 'cfa'>, goal: StudyGoal): StudyPlan {
  const config = FALLBACK_DOMAIN_CONFIG[domain];
  const label = DOMAIN_LABELS[domain];
  const goalLabel = GOAL_LABELS[goal];
  const reason = goal === 'exam-readiness'
    ? `A focused ${label} session builds the readiness signal for your exam goal.`
    : goal === 'retention'
      ? `A focused ${label} session strengthens recall before the next review.`
      : goal === 'skill-building'
        ? `A focused ${label} session builds fluency through deliberate practice.`
        : `A focused ${label} session keeps your study momentum moving.`;
  const followUpReason = domain === 'lsat'
    ? 'Close the loop after timed work with blind review.'
    : 'Use a short review pass to reinforce the concepts you just practiced.';
  const actions: StudyAction[] = [
    {
      kind: 'continue',
      title: config.title,
      path: config.path,
      reason,
      priority: 60,
      domain,
      objective: config.objective,
      estimatedMinutes: config.minutes,
      availability: 'ready',
      rationale: reason,
    },
    {
      kind: 'review',
      title: config.followUpTitle,
      path: config.followUpPath,
      reason: followUpReason,
      priority: 40,
      domain,
      objective: `${domain}:review`,
      estimatedMinutes: 15,
      availability: 'ready',
      rationale: followUpReason,
    },
  ];
  return {
    generatedAt: new Date().toISOString(),
    headline: `${label} · ${goalLabel}`,
    actions,
    backlogActions: [],
    totalActionCount: actions.length,
    totalEstimatedMinutes: actions.reduce((sum, action) => sum + action.estimatedMinutes, 0),
    scheduledMinutes: actions.reduce((sum, action) => sum + action.estimatedMinutes, 0),
    dueCount: 0,
    weakCount: 0,
    peakReviewDay: null,
    interleaving: null,
    rationale: `${label} plan is using a deterministic local fallback while its adaptive planner is unavailable.`,
  };
}

export default function Today() {
  const navigate = useNavigate();
  const focusSession = useStudySession();
  const [studyContext] = useStudyContext();
  const { domain, goal, cfaLevel } = studyContext;
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
  const [journalSaveState, setJournalSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [journalSaveError, setJournalSaveError] = useState('');
  const journalKey = `journal:${new Date().toISOString().slice(0, 10)}`;

  // LEARN-6 — adaptive next-objective routing over HOST content, scoped to this
  // page's plane (CFA). Fully degrading: a down sidecar yields an offline note
  // on the card rather than blocking the local plan above. Selecting a candidate
  // opens the matching host drill keyed by the objective.
  const { report: nextReport, loading: nextLoading, refresh: refreshNext } = useNextQuestions({
    domain: 'cfa',
    count: 5,
    enabled: domain === 'cfa',
  });

  // UX-1: restore the document scroll position when returning to /today (incl.
  // after a cross-domain soft-hop, which bypasses native scroll restoration).
  // Gated on `plan` so we only jump once the real (deterministic-height) content
  // has replaced the loading skeleton, keeping the target offset reachable.
  useScrollRestoration('host:/today', { ready: plan != null });

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
    if (journalSaveState === 'saving') return;
    const text = journal.text;
    const stamp = new Date().toISOString();
    setJournalSaveState('saving');
    setJournalSaveError('');
    try {
      await getStorage().settings.put({ key: journalKey, value: { text, savedAt: stamp }, updatedAt: stamp });
      setJournal({ text, savedAt: stamp, dirty: false });
      setJournalSaveState('idle');
    } catch (error) {
      setJournalSaveState('error');
      setJournalSaveError(error instanceof Error ? error.message : 'The local vault could not save this reflection.');
    }
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
      const next = domain === 'cfa'
        ? await buildStudyPlan({ pathway: activePathway })
        : createDomainFallbackPlan(domain, goal);
      setPlan(next);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let active = true;
    setPlan(null);
    const nextPlan = domain === 'cfa'
      ? buildStudyPlan({ pathway: activePathway })
      : Promise.resolve(createDomainFallbackPlan(domain, goal));
    nextPlan
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
  }, [activePathway, domain, goal]);

  // First weak-topic action, used by the targeted-drill panel.
  const weakAction = plan?.actions?.find((a) => a.kind === 'weak-topic');
  const weakTopic = weakAction ? parseTopicPath(weakAction.path) : null;
  const top = plan?.actions?.[0];
  const activityTopic = weakAction?.objective || top?.objective || `${domain}:today`;
  const answeredQuestionCount = Object.keys(drillAnswers).length;
  const correctAnswerCount = drill.questions.filter((question) => drillAnswers[question.id] === question.correct).length;
  useEffect(() => {
    // An existing provider session can outlive this routed page. Do not replace
    // its persisted totals with Today's freshly-mounted empty drill state.
    if (drill.state !== 'done') return;
    focusSession.updateActivity({
      domain,
      topic: activityTopic,
      questionsAnswered: answeredQuestionCount,
      score: correctAnswerCount,
    });
  }, [answeredQuestionCount, correctAnswerCount, drill.state, weakAction, weakTopic?.topic, focusSession.updateActivity]);

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

  const rest = (plan?.actions || []).slice(1, 5);
  const workload = summarizeTodayWorkload(plan);
  const sessionStatus: TodaySessionStatus = focusSession.session?.status ?? 'none';
  const sessionDomain = focusSession.session?.domain;
  const sameDomainSession = sessionDomain === domain;
  const heroTitle = top
    ? todayHeroTitle({ domain, title: top.title, sessionStatus, sessionDomain })
    : null;
  const primaryActionLabel = top
    ? todayPrimaryActionLabel({ domain, path: top.path, sessionStatus, sessionDomain })
    : 'Start activity';

  const timerPanel = (
    <div className="qv-stack-3">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <span
          className="type-numeric"
          aria-live="polite"
          aria-atomic="true"
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 'var(--fs-2xl, 2rem)',
            fontWeight: 'var(--fw-semibold, 600)',
            letterSpacing: '0.02em',
          }}
        >
          {formatTimer(focusSession.elapsedSeconds)}
        </span>
        <StatusBadge tone={focusSession.session?.status === 'running' ? 'success' : focusSession.session?.status === 'save-error' ? 'danger' : focusSession.session ? 'warning' : 'accent'}>
          {focusSession.session?.status === 'running'
            ? 'Focusing'
            : focusSession.session?.status === 'saving'
              ? 'Saving'
              : focusSession.session?.status === 'save-error'
                ? 'Save failed'
                : focusSession.session
                  ? 'Paused'
                  : 'Ready'}
        </StatusBadge>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {!focusSession.session && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => focusSession.start({
              domain,
              topic: activityTopic,
              questionsAnswered: answeredQuestionCount,
              score: correctAnswerCount,
            })}
          >
            Start focus
          </button>
        )}
        {focusSession.session?.status === 'running' && (
          <>
            <button className="btn btn-secondary btn-sm" onClick={focusSession.pause}>Pause</button>
            <button className="btn btn-secondary btn-sm" onClick={focusSession.stopAndSave}>Stop &amp; log</button>
          </>
        )}
        {focusSession.session?.status === 'paused' && (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => focusSession.start()}>Resume</button>
            <button className="btn btn-secondary btn-sm" onClick={focusSession.stopAndSave}>Stop &amp; log</button>
          </>
        )}
        {focusSession.session?.status === 'save-error' && (
          <>
            <button className="btn btn-primary btn-sm" onClick={focusSession.retrySave}>Retry log</button>
            <button className="btn btn-secondary btn-sm" onClick={() => focusSession.start()}>Keep studying</button>
            <button className="btn btn-secondary btn-sm" onClick={focusSession.discard}>Discard</button>
          </>
        )}
      </div>
      {focusSession.session?.status === 'save-error' && (
        <p role="alert" className="qv-text-danger qv-fs-sm qv-m-0">
          Your session is still saved as a local checkpoint. {focusSession.session.saveError || 'Retry when the vault is available.'}
        </p>
      )}
      <p className="muted-copy qv-fs-sm qv-m-0">
        Counts elapsed focus time and saves a study session to your local vault when you stop.
      </p>
    </div>
  );

  const planPanel = (
    <div className="qv-stack-3">
      <div className="flex-between qv-row-3" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <p className="muted-copy qv-m-0">{plan?.headline}</p>
        <button
          className="btn btn-secondary btn-sm"
          onClick={generateNarrative}
          disabled={!plan || narrative.state === 'loading'}
          title="Generate a personalized rationale for today's plan via your local model"
          style={{ flexShrink: 0 }}
        >
          {narrative.state === 'loading' ? 'Thinking…' : narrative.text ? 'Regenerate narrative' : <><Sparkles size={14} aria-hidden="true" /> Why this plan</>}
        </button>
      </div>
      {narrative.state === 'done' && narrative.text && (
        <p className="qv-callout qv-m-0" style={{ whiteSpace: 'pre-line' }}>{narrative.text}</p>
      )}
      {narrative.state === 'error' && (
        <p className="qv-text-danger qv-fs-sm qv-m-0" role="alert" aria-live="assertive">{narrative.error}</p>
      )}
    </div>
  );

  const journalPanel = (
    <div className="qv-stack-2">
      <div className="flex-between qv-row-3-start" style={{ gap: 'var(--space-3)' }}>
        <p className="muted-copy qv-fs-sm qv-m-0">
          One-paragraph reflection on today's study session. Stays in your local vault, per-date.
        </p>
        <button
          className="btn btn-secondary btn-sm"
          onClick={saveJournal}
          disabled={!journal.dirty || journalSaveState === 'saving'}
          title={journalSaveError || (journal.savedAt ? `Last saved ${new Date(journal.savedAt).toLocaleTimeString()}` : 'Save')}
          style={{ flexShrink: 0 }}
        >
          {journalSaveState === 'saving' ? 'Saving…' : journalSaveState === 'error' ? 'Retry save' : journal.dirty ? 'Save' : journal.savedAt ? 'Saved' : 'Save'}
        </button>
      </div>
      <textarea
        className="input"
        id="today-journal"
        aria-invalid={journalSaveError ? true : undefined}
        aria-describedby={journalSaveError ? 'today-journal-error' : undefined}
        rows={4}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
        placeholder="What did I work on? What clicked? What still feels shaky? What is the smallest next step?"
        value={journal.text}
        onChange={(event) => setJournal((prev) => ({ ...prev, text: event.target.value, dirty: true }))}
        onBlur={() => {
          if (journal.dirty) saveJournal();
        }}
      />
      {journalSaveError && (
        <p id="today-journal-error" role="alert" aria-live="assertive" className="qv-text-danger qv-fs-sm qv-m-0">
          Could not save this reflection. {journalSaveError} Your text is still here; retry when the local vault is available.
        </p>
      )}
    </div>
  );

  return (
    <div className="page-container today-page">
      <PageHeader
        tone="study"
        title="Today"
        subtitle={`${DOMAIN_LABELS[domain]} · ${goalSubtitle(goal)}`}
        meta={
          plan ? (
            <>
              <StatusBadge tone="accent">
                {DOMAIN_LABELS[domain]} · {domain === 'cfa'
                  ? (cfaLevel === 'level1' ? 'Level I' : cfaLevel === 'level2' ? 'Level II' : 'Level III')
                  : GOAL_LABELS[goal]}
              </StatusBadge>
              {plan.dueCount > 0 && <StatusBadge tone="warning">{plan.dueCount} review{plan.dueCount === 1 ? '' : 's'} due</StatusBadge>}
              {plan.weakCount > 0 && <StatusBadge tone="danger">{plan.weakCount} weak topic{plan.weakCount === 1 ? '' : 's'}</StatusBadge>}
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
      />

      {!plan ? (
        // UX-1: deterministic skeleton that mirrors the loaded layout's vertical
        // footprint (study-session card → hero action → "then" list) so the page
        // reserves its height up front and swapping in the real plan doesn't
        // shift content (no CLS). Reuses the shared feedback Skeleton + the
        // shipped `.skeleton*` classes; no new tokens.
        <div role="status" aria-busy="true" aria-label="Loading today’s plan">
          <p className="muted-copy qv-m-0" aria-live="polite">Loading today’s plan…</p>
          {/* Hero "do this next" action */}
          <Surface tone="study" status="accent" className="today-primary-action" style={{ marginBottom: 'var(--space-4)' }}>
            <Skeleton height="6rem" />
          </Surface>
          {/* Collapsed supporting tools */}
          <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-4)' }}>
            <Skeleton variant="text-short" />
          </Surface>
        </div>
      ) : (
        <>
          {top && (
            <Surface tone="study" status="accent" className="today-primary-action">
              <div className="today-primary-action__content">
                <span className="today-primary-action__icon">
                  <ActionIconRender kind={top.kind} size={40} />
                </span>
                <div className="today-primary-action__copy">
                  <span className="today-eyebrow">Recommended now · {GOAL_LABELS[goal]}</span>
                  <h2>{heroTitle}</h2>
                  <p className="muted-copy qv-m-0">{top.reason}</p>
                  {workload.currentLabel && (
                    <small className="today-primary-action__duration">
                      {workload.currentLabel}
                      {workload.remainderLabel && <> · {workload.remainderLabel}</>}
                    </small>
                  )}
                </div>
                <div className="today-primary-action__actions">
                  <Link
                    to={top.path}
                    className="btn btn-primary"
                    onClick={() => {
                      if (!focusSession.session) {
                        focusSession.start({
                          domain,
                          topic: activityTopic,
                          questionsAnswered: answeredQuestionCount,
                          score: correctAnswerCount,
                        });
                      } else if (focusSession.session.status === 'paused' && sameDomainSession) {
                        focusSession.start();
                      }
                    }}
                  >
                    {primaryActionLabel}
                    <ChevronRight size={17} aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </Surface>
          )}

          <OnboardingResume
            onResume={() => navigate('/')}
            onResumeSession={(path) => navigate(path)}
          />

          <div className="today-disclosures">
            <details className="today-disclosure">
              <summary>
                <span>Session tools</span>
                <span className="today-disclosure__meta">
                  {focusSession.session ? formatTimer(focusSession.elapsedSeconds) : 'Timer and journal'}
                </span>
              </summary>
              <div className="today-disclosure__body today-session-tools">
                <section aria-labelledby="today-timer-title">
                  <h3 id="today-timer-title"><Clock size={17} aria-hidden="true" /> Focus timer</h3>
                  {timerPanel}
                </section>
                <section aria-labelledby="today-journal-title">
                  <h3 id="today-journal-title"><NotebookPen size={17} aria-hidden="true" /> Journal</h3>
                  {journalPanel}
                </section>
              </div>
            </details>

            <details className="today-disclosure">
              <summary>
                <span>Full plan</span>
                <span className="today-disclosure__meta">
                  {workload.totalLabel}
                </span>
              </summary>
              <div className="today-disclosure__body qv-stack-4">
                <div className="today-plan-controls">
                  <div>{planPanel}</div>
                  <button className="btn btn-secondary btn-sm" onClick={refresh} disabled={refreshing}>
                    <RefreshCw size={15} aria-hidden="true" /> {refreshing ? 'Regenerating…' : 'Regenerate plan'}
                  </button>
                </div>

                {rest.length > 0 && (
                  <section aria-labelledby="today-up-next-title">
                    <h3 id="today-up-next-title">Up next</h3>
                    <ul className="today-plan-list">
                      {rest.map((action, index) => (
                        <li key={`${action.kind}-${index}`}>
                          <Link to={action.path}>
                            <ActionIconRender kind={action.kind} size={17} />
                            <span>
                              <strong>{action.title}</strong>
                              <small>{action.reason}</small>
                            </span>
                            <ChevronRight size={17} aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

          {/* LEARN-3 — the merged cross-domain plan from the LSAT sidecar (LSAT +
              host CFA/Quant/Excel, reranked by one utility). Self-fetching and
              fully degrading: renders nothing when the sidecar is offline or has
              no host evidence to merge, so the local plan above is never blocked. */}
          {domain === 'cfa' && <UnifiedPlanSection variant="full" />}

          {/* LEARN-6 — adaptive "what to study next" over host (CFA) content,
              ranked against the unified ability. Fully degrading: an offline
              sidecar shows a graceful note. Selecting a row opens the matching
              host drill keyed by the objective. */}
          {domain === 'cfa' && nextReport?.reachable !== false && (
            <div style={{ marginBottom: 'var(--space-6)' }}>
              <AdaptiveRecommendationCard
                report={nextReport}
                loading={nextLoading}
                onRefresh={refreshNext}
                onSelect={(candidate) =>
                  navigate(`/cfa/drills?topic=${encodeURIComponent(candidate.key || candidate.contentId)}`)
                }
                maxItems={5}
              />
            </div>
          )}

          {weakAction && (
            <Surface tone="study" status="warning">
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
                <p className="qv-text-danger qv-mt-2" role="alert" aria-live="assertive" style={{ marginBottom: 0 }}>{drill.error}</p>
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

              </div>
            </details>
          </div>

        </>
      )}
    </div>
  );
}
