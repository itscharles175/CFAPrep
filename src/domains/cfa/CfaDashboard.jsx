import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  ChevronRight,
  ClipboardList,
  DollarSign,
  FileSpreadsheet,
  Gem,
  Inbox,
  Layers,
  LineChart,
  PieChart,
  Shield,
  Sigma,
  Target,
  TrendingUp,
} from 'lucide-react';
import { getCfaLevelSummaries, getCfaRuntimeReport } from './cfaSummary';
import { LEVEL3_PATHWAY_OPTIONS } from './cfaLevel3Pathways';
import { useLevel3Pathway } from './useLevel3Pathway';
import { useProgressSummary } from '../../hooks/useProgress';
import { ActionBar, MetricTile, PageHeader, ProgressRail, SegmentedControl, StatusBadge, Surface } from '../../components/ui/Primitives';
import { SourceCoverageMeter } from '../../components/SourceContext';
import { getCfaSourceCoverageMap, getCfaSourceMapStatus } from '../../lib/cfaSourceVault';
import { buildStudyPlan } from '../../lib/studyDirector';

const iconMap = {
  ethics: Shield,
  'quant-methods': Sigma,
  economics: TrendingUp,
  fsa: FileSpreadsheet,
  corporate: Building2,
  equity: BarChart3,
  'fixed-income': DollarSign,
  derivatives: LineChart,
  alternatives: Gem,
  portfolio: PieChart,
  'asset-allocation': PieChart,
  'portfolio-construction': BarChart3,
  'wealth-planning': Building2,
  'institutional-ips': FileSpreadsheet,
  'fixed-income-pm': DollarSign,
  'equity-pm': BarChart3,
  'derivatives-risk': LineChart,
  'alternatives-pm': Gem,
  performance: Target,
  'pm-pathway': Layers,
  'private-markets-pathway': Gem,
  'private-wealth-pathway': Building2,
};

function levelStats(level) {
  return {
    topics: level.topics.length,
    questions: level.topics.reduce((sum, topic) => sum + topic.questions, 0),
    vignettes: level.topics.reduce((sum, topic) => sum + topic.vignettes, 0),
    flashcards: level.topics.reduce((sum, topic) => sum + topic.flashcards, 0),
    labs: level.topics.reduce((sum, topic) => sum + topic.skillLabs, 0),
    ready: level.topics.length,
  };
}

function completedFor(summary, levelId, topicId) {
  return summary.completedIds.has(`cfa:${levelId}:${topicId}`) || summary.completedIds.has(`cfa:${topicId}`);
}

export default function CfaDashboard() {
  const summary = useProgressSummary();
  const [activePathway, setActivePathway] = useLevel3Pathway();
  const [sourceCoverage, setSourceCoverage] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [studyPlan, setStudyPlan] = useState(null);
  const cfaLevels = useMemo(() => getCfaLevelSummaries({ level3Pathway: activePathway }), [activePathway]);
  const runtimeReport = getCfaRuntimeReport();
  const activeLevels = runtimeReport.levels;
  const totalReadyTopics = cfaLevels.reduce((sum, level) => sum + level.topics.length, 0);
  const totalTopics = cfaLevels.reduce((sum, level) => sum + level.topics.length, 0);
  const firstWeak = summary.weakObjectives[0];

  useEffect(() => {
    let active = true;
    Promise.all([getCfaSourceCoverageMap(), getCfaSourceMapStatus()]).then(([coverage, status]) => {
      if (!active) return;
      setSourceCoverage(coverage);
      setSourceStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    buildStudyPlan({ pathway: activePathway })
      .then((plan) => {
        if (active) setStudyPlan(plan);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [activePathway, summary.questionsAnswered]);

  return (
    <div className="page-container">
      <PageHeader
        tone="exam"
        badge="CFA EXAM COCKPIT"
        title="CFA Exam Mastery"
        subtitle="Level I, II, and III editorial packs, item sets, constructed responses, mocks, flashcards, and review signals in one local-first cockpit."
        meta={
          <>
            <StatusBadge tone="success">{totalReadyTopics}/{totalTopics} topics exam-ready</StatusBadge>
            <StatusBadge tone="exam">{activeLevels.length} active levels</StatusBadge>
          </>
        }
        actions={
          <>
            <Link to="/cfa/level1/mock" className="btn btn-primary"><ClipboardList size={16} /> Level I Mock</Link>
            <Link to="/review" className="btn btn-secondary"><Inbox size={16} /> Review Inbox</Link>
          </>
        }
      />

      <div className="cockpit-grid cockpit-grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricTile label="Readiness Gate" value={`${totalReadyTopics}/${totalTopics}`} detail="Exam-ready topic inventory" icon={Award} tone="exam" />
        <MetricTile label="Study Streak" value={`${summary.streakDays}d`} detail="Local activity trail" icon={TrendingUp} tone="success" />
        <MetricTile label="Questions" value={summary.questionsAnswered.toLocaleString()} detail="Recorded answer rows" icon={Target} tone="accent" />
        <MetricTile label="Weakest Signal" value={firstWeak ? `${firstWeak.score}%` : '-'} detail={firstWeak?.title || 'No weak objective yet'} icon={Inbox} tone="warning" />
      </div>

      {studyPlan && studyPlan.actions.length > 0 && (
        <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
            <div>
              <StatusBadge tone="accent">Study Director</StatusBadge>
              <h3 style={{ margin: 'var(--space-1) 0 0' }}>{studyPlan.headline}</h3>
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                Prioritized from your local FSRS queue, topic readiness, and upcoming review load.
              </p>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {studyPlan.actions.slice(0, 4).map((action, index) => {
              const ActionIcon = action.kind === 'review' ? Inbox : action.kind === 'weak-topic' ? Target : action.kind === 'forecast-spike' ? TrendingUp : ChevronRight;
              const toneByKind = { review: 'warning', 'weak-topic': 'danger', 'forecast-spike': 'exam', continue: 'success' };
              return (
                <li key={`${action.kind}-${index}`}>
                  <Link
                    to={action.path}
                    className="flex-between"
                    style={{ gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-3)', borderRadius: 'var(--radius-md, 8px)', border: '1px solid var(--border)', textDecoration: 'none', color: 'inherit' }}
                  >
                    <span className="qv-row-3">
                      <ActionIcon size={18} />
                      <span>
                        <strong style={{ display: 'block' }}>{action.title}</strong>
                        <small className="muted-copy">{action.reason}</small>
                      </span>
                    </span>
                    <StatusBadge tone={toneByKind[action.kind] || 'accent'}>{action.kind.replace('-', ' ')}</StatusBadge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Surface>
      )}

      <SourceCoverageMeter coverage={sourceCoverage} status={sourceStatus} title="Native CFA Source Layer" />

      <Surface tone="exam" density="compact" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'center' }}>
          <div>
            <StatusBadge tone="exam">Level III exam pathway</StatusBadge>
            <p className="muted-copy">Dashboard, modules, mocks, review, analytics, and source context use common core plus this selected pathway.</p>
          </div>
          <SegmentedControl
            label="Active Level III pathway"
            density="compact"
            options={LEVEL3_PATHWAY_OPTIONS}
            value={activePathway}
            onChange={setActivePathway}
          />
        </div>
      </Surface>

      <div className="cockpit-grid cockpit-grid-3" style={{ marginBottom: 'var(--space-8)' }}>
        {cfaLevels.map((level) => {
          const stats = levelStats(level);
          const readyPct = Math.round((stats.ready / Math.max(1, stats.topics)) * 100);
          return (
            <Surface key={level.id} tone="study" status="exam" className="level-cockpit-card">
              <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start', marginBottom: 'var(--space-4)' }}>
                <div>
                  <h2 style={{ margin: 'var(--space-3) 0 var(--space-1)' }}>{level.title}</h2>
                  <p className="qv-text-secondary qv-m-0">{level.examFormat}</p>
                </div>
                <Link to={`/cfa/${level.id}/mock`} className="btn btn-secondary btn-sm">Mock</Link>
              </div>
              <ProgressRail value={stats.ready} max={stats.topics} label="Editorial gate" detail={`${readyPct}% ready`} tone="exam" />
              <div className="metric-row">
                <div><small>Topics</small><strong>{stats.topics}</strong></div>
                <div><small>Items</small><strong>{stats.questions + stats.vignettes}</strong></div>
                <div><small>Labs</small><strong>{stats.labs}</strong></div>
              </div>
            </Surface>
          );
        })}
      </div>

      {cfaLevels.map((level) => (
        <section key={level.id} style={{ marginBottom: 'var(--space-10)' }}>
          <div className="flex-between" style={{ marginBottom: 'var(--space-4)', gap: 'var(--space-4)', alignItems: 'flex-end' }}>
            <div>
              <StatusBadge tone="exam">{level.title}</StatusBadge>
              <h2 style={{ margin: 'var(--space-2) 0' }}>{level.summary}</h2>
            </div>
            <ActionBar>
              <Link to={`/cfa/${level.id}/mock`} className="btn btn-secondary btn-sm">Start mixed section</Link>
            </ActionBar>
          </div>

          <div className="heatmap-grid">
            {level.topics.map((topic) => {
              const Icon = iconMap[topic.id] || BookOpen;
              const completed = completedFor(summary, level.id, topic.id);
              const ready = true;
              return (
                <Link
                  key={`${level.id}:${topic.id}`}
                  to={`/cfa/${level.id}/${topic.id}`}
                  className={`heatmap-cell ${ready ? '' : 'pending'}`}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  <div className="flex-between" style={{ gap: 'var(--space-3)' }}>
                    <Icon size={18} color={ready ? 'var(--exam)' : 'var(--warning)'} aria-hidden="true" />
                    <ChevronRight size={16} color="var(--text-muted)" aria-hidden="true" />
                  </div>
                  <strong>{topic.label}</strong>
                  <small>{topic.weight} · {topic.questions} Q · {topic.vignettes} cases</small>
                  <small>{sourceCoverage?.topicCounts?.[topic.id] || 0} private source document(s) mapped</small>
                  <div className="qv-row-1" style={{ flexWrap: 'wrap' }}>
                    <StatusBadge tone={completed ? 'success' : ready ? 'exam' : 'warning'}>
                      {completed ? 'complete' : ready ? 'exam-ready' : topic.maturity}
                    </StatusBadge>
                    {!sourceCoverage?.topicCounts?.[topic.id] && (
                      <StatusBadge tone="warning" title="No ingested curriculum yet — grounded answers and the curriculum reader won't show real text for this topic.">
                        no curriculum
                      </StatusBadge>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
