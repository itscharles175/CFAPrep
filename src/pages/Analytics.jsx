import { useEffect, useState } from 'react';
import { Activity, BarChart3, Clock, Gauge, Layers, Target } from 'lucide-react';
import { PageHeader, MetricCard } from '../components/ui/Primitives';
import { getAnalyticsSummary } from '../lib/learning';

function pct(value) {
  return Number.isFinite(value) ? `${value}%` : '-';
}

function seconds(value) {
  if (!value) return '0m';
  const minutes = Math.max(1, Math.round(value / 60));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function Analytics() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let active = true;
    getAnalyticsSummary().then((nextSummary) => {
      if (active) setSummary(nextSummary);
    });
    return () => {
      active = false;
    };
  }, []);

  const topWeakTopics = [...(summary?.byTopic || [])].sort((a, b) => a.accuracy - b.accuracy).slice(0, 8);

  return (
    <div className="page-container">
      <PageHeader
        badge="ANALYTICS"
        title="Learning Analytics"
        subtitle="Local-only performance telemetry by topic, difficulty, error type, confidence, and recent trend."
      />

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Questions" value={summary?.totals.questionsAnswered ?? 0} detail="Recorded answer rows" icon={Target} />
        <MetricCard label="Sessions" value={summary?.totals.sessions ?? 0} detail={seconds(summary?.totals.studyTimeSeconds)} icon={Clock} tone="success" />
        <MetricCard label="Mocks" value={summary?.totals.mockAttempts ?? 0} detail={`${summary?.totals.vignetteAttempts ?? 0} vignettes`} icon={BarChart3} tone="warning" />
        <MetricCard label="Artifacts" value={summary?.totals.artifacts ?? 0} detail="Calculator/lab outputs" icon={Layers} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start', marginBottom: 'var(--space-6)' }}>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Readiness By Level</h3>
          <div className="analytics-table">
            {(summary?.byLevel || []).map((row) => (
              <div className="analytics-row" key={row.level}>
                <span>{row.level}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
            {!summary?.byLevel?.length && <p style={{ color: 'var(--text-secondary)' }}>No level-specific attempts yet.</p>}
          </div>
        </div>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Item-Type Performance</h3>
          <div className="analytics-table">
            {(summary?.byItemType || []).map((row) => (
              <div className="analytics-row" key={row.itemType}>
                <span>{row.itemType}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
            {!summary?.byItemType?.length && <p style={{ color: 'var(--text-secondary)' }}>Quiz, vignette, mock, and skill-lab attempts will appear here.</p>}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Topic Readiness Signals</h3>
          <div className="analytics-table">
            <div className="analytics-row analytics-head">
              <span>Topic</span>
              <span>Accuracy</span>
              <span>Confidence</span>
              <span>Trend</span>
            </div>
            {topWeakTopics.length ? (
              topWeakTopics.map((topic) => (
                <div className="analytics-row" key={topic.topic}>
                  <span>{topic.topic}</span>
                  <strong>{pct(topic.accuracy)}</strong>
                  <span>{pct(topic.averageConfidence)}</span>
                  <span className="badge badge-blue">{topic.recentTrend}</span>
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--text-secondary)' }}>Take quizzes or mock sections to populate topic analytics.</p>
            )}
          </div>
        </div>

        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Confidence Calibration</h3>
          <div className="analytics-table">
            <div className="analytics-row analytics-head">
              <span>Confidence</span>
              <span>Attempts</span>
              <span>Accuracy</span>
              <span>Gap</span>
            </div>
            {(summary?.confidenceCalibration || []).map((row) => (
              <div className="analytics-row" key={row.confidence}>
                <span>{row.confidence}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
                <span>{row.calibrationGap > 0 ? '+' : ''}{row.calibrationGap}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Difficulty Mix</h3>
          <div className="analytics-table">
            {(summary?.byDifficulty || []).map((row) => (
              <div className="analytics-row" key={row.difficulty}>
                <span>{row.difficulty}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Error Types</h3>
          <div className="analytics-table">
            {(summary?.byErrorCategory || []).map((row) => (
              <div className="analytics-row" key={row.errorCategory}>
                <span>{row.errorCategory}</span>
                <strong>{row.attempts}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start', marginTop: 'var(--space-6)' }}>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Level III Rubric Bands</h3>
          <div className="analytics-table">
            {(summary?.essayRubrics || []).map((row) => (
              <div className="analytics-row" key={row.criterion}>
                <span>{row.criterion}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.averagePct)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Skill-Lab Feedback</h3>
          <div className="analytics-table">
            {(summary?.skillLabs || []).slice(0, 8).map((row) => (
              <div className="analytics-row" key={row.labId}>
                <span>{row.labId}</span>
                <strong>{row.attempts}</strong>
                <span>{row.latestScore ?? '-'}</span>
              </div>
            ))}
            {!summary?.skillLabs?.length && <p style={{ color: 'var(--text-secondary)' }}>Calculator, Quant, and Excel drills will feed this panel.</p>}
          </div>
        </div>
      </div>

      <div className="glass-card no-hover" style={{ marginTop: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}><Activity size={18} /> Rolling Trend</h3>
        <div className="forecast-strip">
          {(summary?.rollingTrend || []).map((day) => (
            <div key={day.date}>
              <small>{day.date.slice(5)}</small>
              <strong>{pct(day.accuracy)}</strong>
              <small>{day.attempts} attempts</small>
            </div>
          ))}
          {!summary?.rollingTrend?.length && <p style={{ color: 'var(--text-secondary)' }}>No trend history yet.</p>}
        </div>
      </div>

      <div className="glass-card no-hover" style={{ marginTop: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}><Gauge size={18} /> Reading The Signals</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Positive calibration gaps mean confidence is running ahead of accuracy. Formula dependency and time-pressure errors help identify whether to drill calculations, reread concepts, or slow down on mock review.
        </p>
      </div>
    </div>
  );
}
