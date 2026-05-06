import { Link } from 'react-router-dom';
import {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  ChevronRight,
  DollarSign,
  FileSpreadsheet,
  Gem,
  LineChart,
  PieChart,
  Shield,
  Sigma,
  Target,
  TrendingUp,
} from 'lucide-react';
import { cfaLevels, getCfaRuntimeReport } from './cfaSummary';
import { useProgressSummary } from '../../hooks/useProgress';

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
};

function levelStats(level) {
  return {
    topics: level.topics.length,
    questions: level.topics.reduce((sum, topic) => sum + topic.questions, 0),
    vignettes: level.topics.reduce((sum, topic) => sum + topic.vignettes, 0),
    flashcards: level.topics.reduce((sum, topic) => sum + topic.flashcards, 0),
  };
}

export default function CfaDashboard() {
  const summary = useProgressSummary();
  const runtimeReport = getCfaRuntimeReport();
  const level1Runtime = runtimeReport.levels.find((item) => item.level === 'level1');

  return (
    <div className="page-container">
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <div className="badge badge-gold" style={{ marginBottom: 'var(--space-3)' }}>
          <Award size={12} /> CFA PROGRAM
        </div>
        <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>
          CFA Exam Mastery
        </h1>
        <p className="section-subtitle" style={{ marginBottom: 0 }}>
          Level I, II, and III local-first material bundles with lessons, item sets, mocks, flashcards, and mapped skill labs.
        </p>
        {level1Runtime?.mode === 'exam-ready' && (
          <div className="badge badge-green" style={{ marginTop: 'var(--space-4)' }}>
            Level I editorial exam-ready · local public gate open
          </div>
        )}
      </div>

      <div className="grid-3" style={{ marginBottom: 'var(--space-8)' }}>
        {cfaLevels.map((level) => {
          const stats = levelStats(level);
          return (
            <div key={level.id} className="glass-card no-hover">
              <div className="badge badge-blue">{level.title}</div>
              {level.runtimeMode === 'exam-ready' && <div className="badge badge-green" style={{ marginTop: 'var(--space-2)' }}>{level.runtimeLabel}</div>}
              <h3>{stats.topics} topics</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{level.examFormat}</p>
              <div className="metric-row">
                <div><small>Questions</small><strong>{stats.questions}</strong></div>
                <div><small>Vignettes</small><strong>{stats.vignettes}</strong></div>
                <div><small>Cards</small><strong>{stats.flashcards}</strong></div>
              </div>
              <Link to={`/cfa/${level.id}/mock`} className="btn btn-secondary" style={{ marginTop: 'var(--space-4)' }}>
                Start {level.title} Mock
              </Link>
            </div>
          );
        })}
      </div>

      {cfaLevels.map((level) => (
        <section key={level.id} style={{ marginBottom: 'var(--space-10)' }}>
          <div className="flex-between" style={{ marginBottom: 'var(--space-5)', gap: 'var(--space-4)' }}>
            <div>
              <h2 style={{ margin: 0 }}>{level.title}</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 'var(--space-2) 0 0' }}>{level.summary}</p>
            </div>
            <span className={`badge ${level.runtimeMode === 'exam-ready' ? 'badge-green' : level.runtimeMode === 'validated-beta' ? 'badge-amber' : 'badge-purple'}`}>
              {level.runtimeLabel || level.topics[0]?.maturity || 'draft'}
            </span>
          </div>

          <div className="grid-2">
            {level.topics.map((topic, index) => {
              const Icon = iconMap[topic.id] || BookOpen;
              const completed =
                summary.completedIds.has(`cfa:${level.id}:${topic.id}`) || summary.completedIds.has(`cfa:${topic.id}`);
              return (
                <Link
                  key={`${level.id}:${topic.id}`}
                  to={`/cfa/${level.id}/${topic.id}`}
                  className="glass-card animate-fade"
                  style={{ animationDelay: `${index * 35}ms`, textDecoration: 'none', color: 'inherit' }}
                >
                  <div className="flex-between" style={{ marginBottom: 'var(--space-4)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 'var(--radius-md)',
                          background: 'rgba(59,130,246,0.12)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon size={20} color="var(--accent)" />
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 'var(--fs-base)' }}>{topic.label}</div>
                        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Weight: {topic.weight}</div>
                      </div>
                    </div>
                    <ChevronRight size={18} color="var(--text-muted)" />
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-5)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                    <span>{topic.questions} questions</span>
                    <span>{topic.vignettes} vignettes</span>
                    <span>{topic.skillLabs} labs</span>
                    <span style={{ color: completed ? 'var(--success)' : 'var(--text-muted)' }}>
                      {completed ? 'Complete' : topic.runtimeMode === 'exam-ready' ? 'Exam-ready' : topic.maturity}
                    </span>
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
