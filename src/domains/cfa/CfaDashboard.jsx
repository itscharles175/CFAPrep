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
import { cfaLevels, getCfaRuntimeReport } from './cfaSummary';
import { useProgressSummary } from '../../hooks/useProgress';
import { ActionBar, MetricTile, PageHeader, ProgressRail, StatusBadge, Surface } from '../../components/ui/Primitives';

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
};

function levelStats(level) {
  return {
    topics: level.topics.length,
    questions: level.topics.reduce((sum, topic) => sum + topic.questions, 0),
    vignettes: level.topics.reduce((sum, topic) => sum + topic.vignettes, 0),
    flashcards: level.topics.reduce((sum, topic) => sum + topic.flashcards, 0),
    labs: level.topics.reduce((sum, topic) => sum + topic.skillLabs, 0),
    ready: level.topics.filter((topic) => topic.runtimeMode === 'exam-ready').length,
  };
}

function completedFor(summary, levelId, topicId) {
  return summary.completedIds.has(`cfa:${levelId}:${topicId}`) || summary.completedIds.has(`cfa:${topicId}`);
}

export default function CfaDashboard() {
  const summary = useProgressSummary();
  const runtimeReport = getCfaRuntimeReport();
  const activeLevels = runtimeReport.levels.filter((item) => item.releaseEligible);
  const totalReadyTopics = runtimeReport.levels.reduce((sum, level) => sum + level.examReadyTopics, 0);
  const totalTopics = runtimeReport.levels.reduce((sum, level) => sum + level.topicCount, 0);
  const firstWeak = summary.weakObjectives[0];

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

      <div className="cockpit-grid cockpit-grid-3" style={{ marginBottom: 'var(--space-8)' }}>
        {cfaLevels.map((level) => {
          const stats = levelStats(level);
          const readyPct = Math.round((stats.ready / Math.max(1, stats.topics)) * 100);
          return (
            <Surface key={level.id} tone="study" status={level.runtimeMode === 'exam-ready' ? 'exam' : 'warning'} className="level-cockpit-card">
              <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start', marginBottom: 'var(--space-4)' }}>
                <div>
                  <StatusBadge tone={level.runtimeMode === 'exam-ready' ? 'success' : 'warning'}>{level.runtimeLabel || level.runtimeMode}</StatusBadge>
                  <h2 style={{ margin: 'var(--space-3) 0 var(--space-1)' }}>{level.title}</h2>
                  <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{level.examFormat}</p>
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
              const ready = topic.runtimeMode === 'exam-ready';
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
                  <StatusBadge tone={completed ? 'success' : ready ? 'exam' : 'warning'}>
                    {completed ? 'complete' : ready ? 'exam-ready' : topic.maturity}
                  </StatusBadge>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
