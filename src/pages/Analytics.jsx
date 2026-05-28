import { useEffect, useState } from 'react';
import { Activity, BarChart3, Clock, Gauge, Layers, Target } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader, MetricCard, Panel } from '../components/ui/Primitives';
import { getAnalyticsSummary } from '../lib/learning';
import { forecastReviewLoad } from '../lib/progressStore';
import { SourceRail } from '../components/SourceContext';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';

function pct(value) {
  return Number.isFinite(value) ? `${value}%` : '-';
}

function seconds(value) {
  if (!value) return '0m';
  const minutes = Math.max(1, Math.round(value / 60));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function Analytics() {
  const [activePathway] = useLevel3Pathway();
  const [summary, setSummary] = useState(null);
  const [forecast, setForecast] = useState([]);

  useEffect(() => {
    let active = true;
    getAnalyticsSummary({ level3Pathway: activePathway }).then((nextSummary) => {
      if (active) setSummary(nextSummary);
    });
    forecastReviewLoad(14, new Date(), { level3Pathway: activePathway })
      .then((rows) => {
        if (active) setForecast(rows || []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [activePathway]);

  const forecastChartData = forecast.map((row) => ({
    day: row.date.slice(5), // MM-DD for compactness
    due: row.count,
    atRisk: row.atRiskCount,
  }));

  const topWeakTopics = [...(summary?.byTopic || [])].sort((a, b) => a.accuracy - b.accuracy).slice(0, 8);

  return (
    <div className="page-container">
      <PageHeader
        badge="ANALYTICS"
        title="Learning Analytics"
        subtitle="Local-only performance telemetry by topic, difficulty, error type, confidence, and recent trend."
      />

      <div className="grid-4 page-metrics">
        <MetricCard label="Questions" value={summary?.totals.questionsAnswered ?? 0} detail="Recorded answer rows" icon={Target} />
        <MetricCard label="Sessions" value={summary?.totals.sessions ?? 0} detail={seconds(summary?.totals.studyTimeSeconds)} icon={Clock} tone="success" />
        <MetricCard label="Mocks" value={summary?.totals.mockAttempts ?? 0} detail={`${summary?.totals.vignetteAttempts ?? 0} vignettes`} icon={BarChart3} tone="warning" />
        <MetricCard label="Artifacts" value={summary?.totals.artifacts ?? 0} detail="Calculator/lab outputs" icon={Layers} />
      </div>

      <div className="grid-2 analytics-section-grid">
        <Panel tone="analytics" title="Readiness By Level">
          <div className="analytics-table">
            {(summary?.byLevel || []).map((row) => (
              <div className="analytics-row" key={row.level}>
                <span>{row.level}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
            {!summary?.byLevel?.length && <p className="muted-copy">No level-specific attempts yet.</p>}
          </div>
        </Panel>
        <Panel tone="analytics" title="Item-Type Performance">
          <div className="analytics-table">
            {(summary?.byItemType || []).map((row) => (
              <div className="analytics-row" key={row.itemType}>
                <span>{row.itemType}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
            {!summary?.byItemType?.length && <p className="muted-copy">Quiz, vignette, mock, and skill-lab attempts will appear here.</p>}
          </div>
        </Panel>
      </div>

      <Panel
        tone="analytics"
        title="14-Day Review Load Forecast"
        subtitle="Items the FSRS scheduler projects as due over the next two weeks, with at-risk reviews (low projected retention) called out."
      >
        {forecastChartData.length === 0 ? (
          <p className="muted-copy">No upcoming reviews yet — record some quiz attempts to populate the scheduler.</p>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={forecastChartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={12} />
                <YAxis stroke="var(--text-muted)" allowDecimals={false} fontSize={12} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                />
                <Bar dataKey="due" name="Due" fill="var(--accent, #60a5fa)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="atRisk" name="At risk" fill="var(--warning, #f59e0b)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      {topWeakTopics[0] && (
        <SourceRail
          compact
          title="Weakest Analytics Source Context"
          subtitle="Private snippets mapped to the lowest-accuracy topic in your local telemetry."
          target={{
            kind: 'review-item',
            domain: 'cfa',
            level: topWeakTopics[0].level || 'level1',
            topicId: topWeakTopics[0].topic?.split(':').at(-1) || topWeakTopics[0].topic,
            pathway: topWeakTopics[0].level === 'level3' || topWeakTopics[0].topic?.startsWith('level3:') ? activePathway : undefined,
            title: topWeakTopics[0].topic,
            keywords: [topWeakTopics[0].recentTrend, `${topWeakTopics[0].accuracy} accuracy`],
            route: '/analytics',
          }}
        />
      )}

      <div className="grid-2 analytics-section-grid">
        <Panel tone="analytics" title="Topic Readiness Signals">
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
              <p className="muted-copy">Take quizzes or mock sections to populate topic analytics.</p>
            )}
          </div>
        </Panel>

        <Panel tone="analytics" title="Confidence Calibration">
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
        </Panel>

        <Panel tone="analytics" title="Difficulty Mix">
          <div className="analytics-table">
            {(summary?.byDifficulty || []).map((row) => (
              <div className="analytics-row" key={row.difficulty}>
                <span>{row.difficulty}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.accuracy)}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel tone="analytics" title="Error Types">
          <div className="analytics-table">
            {(summary?.byErrorCategory || []).map((row) => (
              <div className="analytics-row" key={row.errorCategory}>
                <span>{row.errorCategory}</span>
                <strong>{row.attempts}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid-2 analytics-section-grid">
        <Panel tone="analytics" title="Level III Rubric Bands">
          <div className="analytics-table">
            {(summary?.essayRubrics || []).map((row) => (
              <div className="analytics-row" key={row.criterion}>
                <span>{row.criterion}</span>
                <strong>{row.attempts}</strong>
                <span>{pct(row.averagePct)}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel tone="analytics" title="Skill-Lab Feedback">
          <div className="analytics-table">
            {(summary?.skillLabs || []).slice(0, 8).map((row) => (
              <div className="analytics-row" key={row.labId}>
                <span>{row.labId}</span>
                <strong>{row.attempts}</strong>
                <span>{row.latestScore ?? '-'} / {row.impact ?? 0}</span>
              </div>
            ))}
            {!summary?.skillLabs?.length && <p className="muted-copy">Calculator, Quant, and Excel drills will feed this panel.</p>}
          </div>
        </Panel>
      </div>

      <div className="grid-2 analytics-section-grid">
        <Panel tone="analytics" title="Constructed-Response Weaknesses">
          <div className="analytics-table">
            {(summary?.constructedResponseWeaknesses || []).slice(0, 6).map((row) => (
              <div className="analytics-row" key={row.criterion}>
                <span>{row.criterion}</span>
                <strong>{pct(row.averagePct)}</strong>
                <span>{row.impact}</span>
              </div>
            ))}
            {!summary?.constructedResponseWeaknesses?.length && <p className="muted-copy">Rubric weakness signals appear after Level III responses.</p>}
          </div>
        </Panel>
        <Panel tone="analytics" title="Objective Impact">
          <div className="analytics-table">
            {(summary?.objectiveImpacts || []).slice(0, 8).map((row) => (
              <div className="analytics-row" key={`${row.sourceType}:${row.objectiveId}`}>
                <span>{row.objectiveId}</span>
                <strong>{row.sourceType}</strong>
                <span>{row.impact}</span>
              </div>
            ))}
            {!summary?.objectiveImpacts?.length && <p className="muted-copy">Calculator and lab artifacts with objective metadata will appear here.</p>}
          </div>
        </Panel>
      </div>

      <Panel tone="analytics" title="Rolling Trend" icon={Activity} className="analytics-wide-panel">
        <div className="forecast-strip">
          {(summary?.rollingTrend || []).map((day) => (
            <div key={day.date}>
              <small>{day.date.slice(5)}</small>
              <strong>{pct(day.accuracy)}</strong>
              <small>{day.attempts} attempts</small>
            </div>
          ))}
          {!summary?.rollingTrend?.length && <p className="muted-copy">No trend history yet.</p>}
        </div>
      </Panel>

      <Panel tone="analytics" title="Reading The Signals" icon={Gauge} className="analytics-wide-panel">
        <p className="muted-copy">
          Positive calibration gaps mean confidence is running ahead of accuracy. Formula dependency and time-pressure errors help identify whether to drill calculations, reread concepts, or slow down on mock review.
        </p>
      </Panel>
    </div>
  );
}
