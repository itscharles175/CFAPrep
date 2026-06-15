import { useEffect, useState } from 'react';
import { Activity, BarChart3, Clock, Gauge, Layers, Target } from 'lucide-react';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader, MetricCard, Panel, SegmentedControl } from '../components/ui/Primitives';
import { getAnalyticsSummary } from '../lib/learning';
import { db, forecastReviewLoad } from '../lib/progressStore';
import { predictRetention } from '../lib/scheduler';
import { SourceRail } from '../components/SourceContext';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { projectExamReadiness } from '../lib/examReadiness';
import { getStorage } from '../lib/storage';
import { getLsatActivity, getLsatCalibration } from '../lib/lsatAnalyticsBridge';
import { getLsatCrossDomain } from '../lib/lsatCrossDomainBridge';

// ANL-6 — cross-domain color coding. CFA reuses the host accent (blue, the
// analytics default); LSAT gets a distinct violet so the two series read apart
// in the heatmap legend, the calibration scatter, and the domain toggle.
const DOMAIN_COLOR = {
  cfa: 'var(--accent, #60a5fa)',
  lsat: 'var(--quant, #c084fc)',
};

// CFA | LSAT | All toggle options (All = combined per-day activity / both
// calibration series overlaid).
const DOMAIN_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'cfa', label: 'CFA' },
  { value: 'lsat', label: 'LSAT' },
];

// LSAT confidence bands map to a 0–100 x position for the calibration scatter,
// parallel to the host's low/medium/high (sure≈high, likely≈medium, guess≈low).
const LSAT_CONFIDENCE_X = { sure: 75, likely: 50, guess: 25 };

function pct(value) {
  return Number.isFinite(value) ? `${value}%` : '-';
}

function seconds(value) {
  if (!value) return '0m';
  const minutes = Math.max(1, Math.round(value / 60));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ANL-1 — host study-minute estimate for the cross-domain merge. The host does
// not record per-question time locally, so approximate each in-window question
// attempt at ~1.5 min (a conservative mixed quiz/vignette pace) for a comparable
// "study time" figure beside the LSAT sidecar's measured minutes.
const HOST_MINUTES_PER_ATTEMPT = 1.5;
function summaryStudyMinutes(rows, windowStart) {
  let n = 0;
  for (const row of rows || []) {
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    if (Number.isFinite(at) && at >= windowStart) n += 1;
  }
  return Math.round(n * HOST_MINUTES_PER_ATTEMPT);
}

// ANL-1 — current host streak: consecutive days (back from today, allowing
// yesterday when today is empty) with at least one local question attempt.
function hostStreakFromResults(rows) {
  const days = new Set();
  for (const row of rows || []) {
    if (typeof row.createdAt === 'string') days.add(row.createdAt.slice(0, 10));
  }
  if (days.size === 0) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let cursor = today.getTime();
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Allow the streak to count from yesterday if today has no activity yet.
  if (!days.has(key(cursor)) && days.has(key(cursor - dayMs))) cursor -= dayMs;
  let streak = 0;
  while (days.has(key(cursor))) {
    streak += 1;
    cursor -= dayMs;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// StudyStreakHeatmap – Pillar 9
// ---------------------------------------------------------------------------
const CELL = 12; // px
const GAP = 2; // px
const COLS = 12; // weeks
const ROWS = 7; // Mon=0 … Sun=6

// Intensity ramp keyed to a base RGB triplet so each domain (CFA blue / LSAT
// violet) shares the same 5-bucket scale while staying color-coded. `combined`
// (the "All" view) blends to the CFA accent token so it matches the rest of the
// analytics charts.
const DOMAIN_RAMP = {
  cfa: '96, 165, 250', // accent blue
  lsat: '192, 132, 252', // quant violet
};

function cellColor(count, domain) {
  if (count === 0) return 'var(--border)';
  const rgb = DOMAIN_RAMP[domain] || DOMAIN_RAMP.cfa;
  if (count <= 2) return `rgba(${rgb}, 0.25)`;
  if (count <= 5) return `rgba(${rgb}, 0.50)`;
  if (count <= 10) return `rgba(${rgb}, 0.75)`;
  return `rgba(${rgb}, 1)`;
}

const LEGEND_LABELS = ['None', '1–2', '3–5', '6–10', '11+'];
const LEGEND_SAMPLE_COUNT = [0, 1, 3, 6, 11];

/**
 * ANL-6 — unified study-streak heatmap. The parent (`Analytics`) owns the data
 * + domain toggle: `cfaCounts` is the host Dexie per-day map; `lsatCounts` is
 * the LSAT sidecar per-day map (empty when the sidecar is unreachable). `domain`
 * is "cfa" | "lsat" | "all"; "all" sums both domains per day. Cell color is keyed
 * to the active domain so CFA reads blue and LSAT reads violet; "all" uses the
 * CFA accent ramp to match the surrounding analytics charts.
 */
function StudyStreakHeatmap({ cfaCounts, lsatCounts, domain, lsatReachable }) {
  // null counts = still loading the host telemetry.
  const loading = cfaCounts === null;
  const cfa = cfaCounts || new Map();
  const lsat = lsatCounts || new Map();
  const rampDomain = domain === 'lsat' ? 'lsat' : 'cfa';

  // Per-day count for a given date under the active domain selection.
  function countFor(dateStr) {
    const c = cfa.get(dateStr) || 0;
    const l = lsat.get(dateStr) || 0;
    if (domain === 'cfa') return c;
    if (domain === 'lsat') return l;
    return c + l; // all
  }

  // Compute "end of current week" so today lands in the last column, last applicable row.
  // We define week as Mon–Sun. "End of this week" = the coming Sunday (or today if Sunday).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDow = today.getDay(); // 0=Sun … 6=Sat
  // Days until Sunday from today
  const daysUntilSunday = todayDow === 0 ? 0 : 7 - todayDow;
  const sunday = new Date(today);
  sunday.setDate(sunday.getDate() + daysUntilSunday);

  // Grid: col 0 = oldest (leftmost), col COLS-1 = this week (rightmost)
  // row 0 = Mon, row 6 = Sun
  // Date for cell (col, row):
  //   sunday - (COLS-1-col)*7 - (6-row) days
  const cells = [];

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const daysBack = (COLS - 1 - col) * 7 + (6 - row);
      const d = new Date(sunday);
      d.setDate(sunday.getDate() - daysBack);
      const dateStr = d.toISOString().slice(0, 10);
      const isFuture = d.getTime() > today.getTime();
      const count = (!isFuture && !loading) ? countFor(dateStr) : 0;
      const cfaCount = (!isFuture && !loading) ? (cfa.get(dateStr) || 0) : 0;
      const lsatCount = (!isFuture && !loading) ? (lsat.get(dateStr) || 0) : 0;
      cells.push({ col, row, dateStr, count, cfaCount, lsatCount, isFuture });
    }
  }

  // Total attempts in the 12-week window under the active domain.
  let total12w = 0;
  if (!loading) {
    for (const { count, isFuture } of cells) {
      if (!isFuture) total12w += count;
    }
  }

  const svgWidth = COLS * (CELL + GAP) - GAP;
  const svgHeight = ROWS * (CELL + GAP) - GAP;

  const domainLabel = domain === 'cfa' ? 'CFA' : domain === 'lsat' ? 'LSAT' : 'all domains';

  return (
    <Panel
      tone="analytics"
      title="Study Streak Heatmap"
      subtitle={
        domain === 'all'
          ? 'Combined daily activity across CFA + LSAT (CFA local telemetry + LSAT sidecar).'
          : domain === 'lsat'
            ? 'Daily LSAT activity from the LSAT sidecar.'
            : 'Daily CFA / Quant / Excel activity from local telemetry.'
      }
    >
      {loading ? (
        <p className="muted-copy">Loading heatmap…</p>
      ) : total12w === 0 ? (
        <p className="muted-copy">
          {domain === 'lsat' && !lsatReachable
            ? 'LSAT sidecar unreachable — start StudyVault’s LSAT backend on :8100 to see LSAT activity.'
            : `No ${domainLabel} attempts in the last 12 weeks — answer some questions to see your streak.`}
        </p>
      ) : (
        <>
          <p className="qv-fs-sm qv-text-secondary" style={{ marginBottom: 12 }}>
            <strong>{total12w}</strong> question{total12w !== 1 ? 's' : ''} answered in the last 12 weeks ({domainLabel})
          </p>
          {domain !== 'cfa' && !lsatReachable && (
            <p className="qv-fs-sm qv-text-muted" style={{ marginBottom: 12 }}>
              LSAT sidecar unreachable — showing CFA activity only.
            </p>
          )}
          <svg
            width={svgWidth}
            height={svgHeight}
            style={{ display: 'block', overflow: 'visible' }}
            aria-label={`Study streak heatmap (${domainLabel})`}
          >
            {cells.map(({ col, row, dateStr, count, cfaCount, lsatCount, isFuture }) => (
              <rect
                key={`${col}-${row}`}
                x={col * (CELL + GAP)}
                y={row * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2}
                ry={2}
                fill={isFuture ? 'transparent' : cellColor(count, rampDomain)}
                opacity={isFuture ? 0 : 1}
              >
                {!isFuture && (
                  <title>
                    {dateStr} · {count} attempt{count !== 1 ? 's' : ''}
                    {domain === 'all' ? ` (CFA ${cfaCount} · LSAT ${lsatCount})` : ''}
                  </title>
                )}
              </rect>
            ))}
          </svg>
          {/* Legend */}
          <div className="qv-row-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <span className="qv-text-muted" style={{ fontSize: 11 }}>Less</span>
            {LEGEND_LABELS.map((label, i) => (
              <div key={label} className="qv-row-1">
                <div
                  style={{
                    width: CELL,
                    height: CELL,
                    borderRadius: 2,
                    background: cellColor(LEGEND_SAMPLE_COUNT[i], rampDomain),
                    border: '1px solid var(--border)',
                    flexShrink: 0,
                  }}
                  title={label}
                />
                <span className="qv-text-muted" style={{ fontSize: 11 }}>{label}</span>
              </div>
            ))}
            <span className="qv-text-muted" style={{ fontSize: 11 }}>More</span>
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * ANL-1 — combined cross-domain study summary. `report` is the merged rollup
 * from the LSAT sidecar's `/api/analytics/cross-domain` (study time, accuracy by
 * domain, merged weakest types, combined streak, 30-day trend), with the host's
 * own CFA/Quant numbers folded in server-side. `null` = still loading; an
 * unreachable sidecar resolves to `reachable: false` and the panel degrades to a
 * host-only message. The CFA / LSAT / All `domain` toggle filters the per-domain
 * accuracy + weakest-types rows shown.
 */
function CrossDomainSummary({ report, domain, lsatReachable }) {
  const subtitle =
    'One bidirectional rollup: combined study time, accuracy by domain, the longest active streak, and the weakest types across CFA + LSAT (host numbers merged with the LSAT sidecar).';

  if (report === null) {
    return (
      <Panel tone="analytics" title="Cross-Domain Summary" subtitle={subtitle}>
        <p className="muted-copy">Loading cross-domain summary…</p>
      </Panel>
    );
  }

  const byDomain = report.accuracyByDomain || [];
  const showLsatRow = domain !== 'cfa';
  const showHostRow = domain !== 'lsat';
  const rows = byDomain.filter(
    (row) => (row.domain === 'lsat' ? showLsatRow : showHostRow),
  );

  // Weakest types filtered by the active domain toggle ("host" rows read as CFA).
  const weakest = (report.weakestTypes || [])
    .filter((row) => (domain === 'all' ? true : (domain === 'lsat' ? row.domain === 'lsat' : row.domain === 'host')))
    .slice(0, 5);

  const trend30 = (report.trend || []).map((row) => ({
    day: row.date.slice(5),
    questions: row.questions,
  }));

  const domainLabel = (d) => (d === 'lsat' ? 'LSAT' : 'CFA / Quant');

  return (
    <Panel tone="analytics" title="Cross-Domain Summary" subtitle={subtitle}>
      {!report.reachable && !lsatReachable && (
        <p className="qv-fs-sm qv-text-muted" style={{ marginBottom: 12 }}>
          LSAT sidecar unreachable — start StudyVault’s LSAT backend on :8100 to combine LSAT analytics with your CFA telemetry.
        </p>
      )}
      {!report.reachable && lsatReachable && (
        <p className="qv-fs-sm qv-text-muted" style={{ marginBottom: 12 }}>
          Showing the host (CFA / Quant) summary — the LSAT cross-domain rollup didn’t respond this time.
        </p>
      )}
      <div className="qv-row-2 qv-mb-3" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <span className="qv-chip qv-text-secondary">Combined study {seconds(report.studyMinutes * 60)}</span>
        <span className="qv-chip qv-text-success">Longest active streak {report.combinedStreakDays}d</span>
      </div>

      <div className="analytics-table" style={{ marginBottom: 16 }}>
        <div className="analytics-row analytics-head">
          <span>Domain</span>
          <span>Attempts</span>
          <span>Accuracy</span>
          <span>Streak</span>
        </div>
        {rows.length ? (
          rows.map((row) => (
            <div className="analytics-row" key={row.domain}>
              <span style={{ color: DOMAIN_COLOR[row.domain === 'lsat' ? 'lsat' : 'cfa'] }}>
                {domainLabel(row.domain)}
              </span>
              <strong>{row.attempts}</strong>
              <span>{row.accuracy === null ? '-' : `${Math.round(row.accuracy * 100)}%`}</span>
              <span>{row.streakDays}d</span>
            </div>
          ))
        ) : (
          <p className="muted-copy">No attempts in the selected domain yet.</p>
        )}
      </div>

      {weakest.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <p className="qv-fs-sm qv-text-secondary" style={{ marginBottom: 8 }}>
            Weakest types (lowest accuracy first)
          </p>
          <div className="qv-row-2" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {weakest.map((row) => (
              <span
                key={`${row.domain}:${row.label}`}
                className="qv-chip qv-text-muted"
                title={`${domainLabel(row.domain)} · ${row.attempts} attempts`}
                style={{ borderColor: DOMAIN_COLOR[row.domain === 'lsat' ? 'lsat' : 'cfa'] }}
              >
                {row.label}
                {row.accuracy !== null && ` · ${Math.round(row.accuracy * 100)}%`}
              </span>
            ))}
          </div>
        </div>
      )}

      {trend30.length > 0 && (
        <div style={{ width: '100%', height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trend30} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} interval={Math.max(1, Math.floor(trend30.length / 8))} />
              <YAxis stroke="var(--text-muted)" allowDecimals={false} fontSize={12} />
              <Tooltip
                contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(value) => [value, 'Questions']}
              />
              <Area type="monotone" dataKey="questions" name="Combined questions" stroke="var(--accent, #60a5fa)" fill="var(--accent-soft, rgba(96,165,250,0.18))" strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

export default function Analytics() {
  const [activePathway] = useLevel3Pathway();
  const [summary, setSummary] = useState(null);
  const [forecast, setForecast] = useState([]);
  const [masteryTrend, setMasteryTrend] = useState([]);
  const [retentionDecay, setRetentionDecay] = useState([]);
  const [readiness, setReadiness] = useState(null);
  // ANL-6 — cross-domain toggle + data. `domain` drives both the heatmap and
  // the calibration scatter. CFA counts come from local Dexie telemetry; the
  // LSAT activity/calibration come from the sidecar (best-effort, degrading).
  const [domain, setDomain] = useState('all');
  const [cfaHeatCounts, setCfaHeatCounts] = useState(null); // null = loading
  const [lsatHeatCounts, setLsatHeatCounts] = useState(new Map());
  const [lsatCalibration, setLsatCalibration] = useState([]);
  const [lsatReachable, setLsatReachable] = useState(false);
  // ANL-1 — combined cross-domain rollup pulled from the LSAT sidecar
  // (`/api/analytics/cross-domain`), merged with the host's own CFA/Quant totals
  // so the page shows one bidirectional study summary. Best-effort + degrading.
  const [crossDomain, setCrossDomain] = useState(null);

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

    // Mastery-over-time: aggregate masterySnapshots by lastAttemptAt date
    // (last 30 days), report daily mean score across topics touched that day.
    db.masterySnapshots
      .toArray()
      .then((snapshots) => {
        if (!active) return;
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const byDay = new Map();
        for (const snap of snapshots) {
          const at = Date.parse(snap.lastAttemptAt);
          if (!Number.isFinite(at) || at < cutoff) continue;
          const day = snap.lastAttemptAt.slice(0, 10);
          const bucket = byDay.get(day) || { sum: 0, count: 0 };
          bucket.sum += snap.score;
          bucket.count += 1;
          byDay.set(day, bucket);
        }
        const trend = [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, { sum, count }]) => ({ day: day.slice(5), score: Math.round(sum / count) }));
        setMasteryTrend(trend);
      })
      .catch(() => undefined);

    // 30-day retention decay: average projected retrievability across all
    // FSRS review items at today + d days (d in 0..30). Visualizes how the
    // current memory state decays under the FSRS model if nothing is reviewed.
    db.reviewItems
      .toArray()
      .then((items) => {
        if (!active || !items.length) {
          setRetentionDecay([]);
          return;
        }
        const today = new Date();
        const points = [];
        for (let d = 0; d <= 30; d += 1) {
          const target = new Date(today.getTime() + d * 86400000);
          const sum = items.reduce((acc, item) => acc + predictRetention(item, target), 0);
          points.push({ day: d === 0 ? 'Today' : `+${d}d`, retention: Math.round((sum / items.length) * 100) });
        }
        setRetentionDecay(points);
      })
      .catch(() => undefined);

    // CFA streak heatmap: build a YYYY-MM-DD → attempt-count map from local
    // question results. Owned by the parent (ANL-6) so the domain toggle can
    // combine it with the LSAT sidecar's per-day activity.
    db.questionResults
      .toArray()
      .then((rows) => {
        if (!active) return;
        const counts = new Map();
        for (const row of rows) {
          if (!row.createdAt) continue;
          const day = row.createdAt.slice(0, 10);
          counts.set(day, (counts.get(day) || 0) + 1);
        }
        setCfaHeatCounts(counts);
      })
      .catch(() => {
        if (active) setCfaHeatCounts(new Map());
      });

    // Exam-readiness cockpit: projected mastery curve with confidence band,
    // anchored on the user's target exam date (System Health → Exam Date).
    Promise.all([
      db.masterySnapshots.toArray(),
      db.questionResults.toArray(),
      getStorage().settings.get('exam-date'),
    ])
      .then(([snapshots, results, examRow]) => {
        if (!active) return;
        const examDate = typeof examRow?.value === 'string' ? examRow.value : null;
        const projection = projectExamReadiness({ snapshots, results, examDate });
        setReadiness(projection);
      })
      .catch(() => undefined);

    // ANL-6 — LSAT sidecar activity + calibration (best-effort; the bridge never
    // throws, returning `reachable: false` + empty data when the sidecar is down,
    // so the page degrades to a host-only view). Treat reachability as the OR of
    // the two probes so either signal lights the cross-domain views.
    getLsatActivity(120)
      .then((report) => {
        if (!active) return;
        const counts = new Map();
        for (const row of report.days) {
          if (!row.date) continue;
          counts.set(row.date, (counts.get(row.date) || 0) + (row.questions || 0));
        }
        setLsatHeatCounts(counts);
        if (report.reachable) setLsatReachable(true);
      })
      .catch(() => undefined);
    getLsatCalibration()
      .then((report) => {
        if (!active) return;
        setLsatCalibration(report.bands || []);
        if (report.reachable) setLsatReachable(true);
      })
      .catch(() => undefined);

    // ANL-1 — combined cross-domain rollup. Derive the host (CFA/Quant/Excel)
    // numbers over the same 30-day window from local Dexie telemetry, then pull
    // the LSAT sidecar's `/api/analytics/cross-domain` rollup WITH those numbers
    // so the backend returns one merged study summary (study time, accuracy by
    // domain, merged weakest types, combined streak). Best-effort + degrading:
    // the bridge resolves to `{ reachable: false, ... }` on any failure.
    db.questionResults
      .toArray()
      .then((rows) => {
        const windowStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
        let hostAttempts = 0;
        let hostCorrect = 0;
        for (const row of rows || []) {
          const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
          if (!Number.isFinite(at) || at < windowStart) continue;
          hostAttempts += 1;
          if (row.correct) hostCorrect += 1;
        }
        // Approximate host study minutes in the window from total study time
        // (the host doesn't track per-question time locally). Streak comes from
        // distinct active CFA days in the trailing run.
        const hostStudyMinutes = summaryStudyMinutes(rows, windowStart);
        return getLsatCrossDomain({
          days: 30,
          hostAttempts,
          hostCorrect,
          hostStudyMinutes,
          hostStreakDays: hostStreakFromResults(rows),
        });
      })
      .then((report) => {
        if (!active || !report) return;
        setCrossDomain(report);
        if (report.reachable) setLsatReachable(true);
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
        actions={
          <SegmentedControl
            label="Analytics domain"
            options={DOMAIN_OPTIONS}
            value={domain}
            onChange={setDomain}
            density="compact"
          />
        }
      />

      <div className="grid-4 page-metrics">
        <MetricCard label="Questions" value={summary?.totals.questionsAnswered ?? 0} detail="Recorded answer rows" icon={Target} />
        <MetricCard label="Sessions" value={summary?.totals.sessions ?? 0} detail={seconds(summary?.totals.studyTimeSeconds)} icon={Clock} tone="success" />
        <MetricCard label="Mocks" value={summary?.totals.mockAttempts ?? 0} detail={`${summary?.totals.vignetteAttempts ?? 0} vignettes`} icon={BarChart3} tone="warning" />
        <MetricCard label="Artifacts" value={summary?.totals.artifacts ?? 0} detail="Calculator/lab outputs" icon={Layers} />
      </div>

      <CrossDomainSummary report={crossDomain} domain={domain} lsatReachable={lsatReachable} />

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
        title="Exam-Readiness Cockpit"
        subtitle={
          readiness?.examDate
            ? `Projected mastery from today (${readiness.startDate}) to your exam on ${readiness.examDate} (${readiness.daysUntilExam} days) — 95% confidence band based on your trailing-14-day attempt rate.`
            : 'Projected mastery for the next 90 days. Set an exam date in System Health → Exam Date to anchor the projection.'
        }
      >
        {!readiness || readiness.points.length === 0 ? (
          <p className="muted-copy">No mastery snapshots yet — answer a few quiz questions to populate the projection.</p>
        ) : (
          <>
            <div className="qv-row-2 qv-mb-3" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
              <span className="qv-chip qv-text-secondary">Current {readiness.currentMastery}%</span>
              {readiness.projectedOnExamDate !== null && (
                <span className="qv-chip qv-text-success">
                  Projected{readiness.examDate ? ' on exam' : ' in 90d'} {readiness.projectedOnExamDate}%
                  {readiness.projectedBand && ` (±${Math.round((readiness.projectedBand.upper - readiness.projectedBand.lower) / 2)}%)`}
                </span>
              )}
              <span className="qv-chip qv-text-muted">~{readiness.averageDailyAttempts} attempts/day</span>
              <span className="qv-chip qv-text-muted">Accuracy {Math.round(readiness.averageAccuracy * 100)}%</span>
              <span className="qv-chip qv-text-muted">Per-attempt lift +{readiness.perAttemptLift} pts</span>
            </div>
            <div style={{ width: '100%', height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={readiness.points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} interval={Math.max(1, Math.floor(readiness.points.length / 8))} />
                  <YAxis stroke="var(--text-muted)" domain={[0, 100]} fontSize={12} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                    labelStyle={{ color: 'var(--text-secondary)' }}
                  />
                  <Area type="monotone" dataKey="upper" stroke="none" fill="var(--accent-soft, rgba(96,165,250,0.18))" fillOpacity={0.6} />
                  <Area type="monotone" dataKey="lower" stroke="none" fill="var(--surface, #0f172a)" fillOpacity={1} />
                  <Line type="monotone" dataKey="projected" name="Projected mastery" stroke="var(--accent, #60a5fa)" strokeWidth={2.5} dot={false} />
                  {readiness.examDate && (
                    <ReferenceLine x={readiness.examDate} stroke="var(--danger, #f87171)" strokeDasharray="4 4" label={{ value: 'Exam', position: 'top', fill: 'var(--danger)' }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </Panel>

      <Panel
        tone="analytics"
        title="Mastery Over Time"
        subtitle="Average mastery score across topics touched on each day (last 30 days)."
      >
        {masteryTrend.length === 0 ? (
          <p className="muted-copy">No mastery snapshots yet — answer a few quiz questions to populate the trend.</p>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={masteryTrend} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={12} />
                <YAxis stroke="var(--text-muted)" domain={[0, 100]} fontSize={12} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                />
                <Line type="monotone" dataKey="score" name="Mastery %" stroke="var(--success, #34d399)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <Panel
        tone="analytics"
        title="30-Day Retention Decay"
        subtitle="If you reviewed nothing more, the FSRS model projects this average retention curve across your active items."
      >
        {retentionDecay.length === 0 ? (
          <p className="muted-copy">No active review items yet — answer some quiz questions to populate the FSRS state.</p>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={retentionDecay} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={12} interval={4} />
                <YAxis stroke="var(--text-muted)" domain={[0, 100]} fontSize={12} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                />
                <Line type="monotone" dataKey="retention" name="Avg retention %" stroke="var(--warning, #f59e0b)" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

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

      {/* Confidence vs Accuracy Calibration scatter (ANL-6: CFA + LSAT overlay) */}
      {(() => {
        const CONFIDENCE_X = { low: 25, medium: 50, high: 75 };
        // CFA: host confidence buckets (low/medium/high), accuracy already 0–100.
        const cfaData = (summary?.confidenceCalibration || []).map((row) => ({
          label: `CFA · ${row.confidence}`,
          x: CONFIDENCE_X[row.confidence] ?? 50,
          y: row.accuracy ?? 0,
          attempts: row.attempts ?? 0,
        }));
        // LSAT: sidecar confidence bands (sure/likely/guess). Accuracy is 0–1 here,
        // so scale to 0–100; skip empty bands (null accuracy). Color-coded violet.
        const lsatData = lsatCalibration
          .filter((row) => row.accuracy !== null && row.attempts > 0)
          .map((row) => ({
            label: `LSAT · ${row.confidence}`,
            x: LSAT_CONFIDENCE_X[row.confidence] ?? 50,
            y: Math.round((row.accuracy ?? 0) * 100),
            attempts: row.attempts ?? 0,
          }));
        const showCfa = domain !== 'lsat';
        const showLsat = domain !== 'cfa';
        const hasCfa = showCfa && cfaData.length > 0;
        const hasLsat = showLsat && lsatData.length > 0;
        const diagonalData = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
        return (
          <Panel
            tone="analytics"
            title="Confidence vs Accuracy Calibration"
            subtitle={
              domain === 'all'
                ? 'Each marker is a confidence bucket — CFA (blue) vs LSAT (violet). Above the 1:1 diagonal = underconfident; below = overconfident.'
                : domain === 'lsat'
                  ? 'Each marker is an LSAT confidence band (sure/likely/guess). Perfect calibration is a 1:1 diagonal.'
                  : 'Each marker is a confidence bucket; perfect calibration is a 1:1 diagonal.'
            }
          >
            {!hasCfa && !hasLsat ? (
              <p className="muted-copy">
                {domain === 'lsat' && !lsatReachable
                  ? 'LSAT sidecar unreachable — start StudyVault’s LSAT backend on :8100 to see LSAT calibration.'
                  : 'No confidence-labeled attempts yet — answer questions with a confidence rating to populate this chart.'}
              </p>
            ) : (
              <>
                {showLsat && !lsatReachable && (
                  <p className="qv-fs-sm qv-text-muted" style={{ marginBottom: 12 }}>
                    LSAT sidecar unreachable — showing CFA calibration only.
                  </p>
                )}
                <div style={{ width: '100%', height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 16, right: 24, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        type="number"
                        dataKey="x"
                        name="Confidence"
                        domain={[0, 100]}
                        stroke="var(--text-muted)"
                        fontSize={12}
                        label={{ value: 'Confidence %', position: 'insideBottomRight', offset: -4, fontSize: 11, fill: 'var(--text-muted)' }}
                      />
                      <YAxis
                        type="number"
                        dataKey="y"
                        name="Accuracy"
                        domain={[0, 100]}
                        stroke="var(--text-muted)"
                        fontSize={12}
                        label={{ value: 'Accuracy %', angle: -90, position: 'insideLeft', offset: 8, fontSize: 11, fill: 'var(--text-muted)' }}
                      />
                      <Tooltip
                        cursor={{ strokeDasharray: '3 3' }}
                        contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                        labelStyle={{ color: 'var(--text-secondary)' }}
                        formatter={(value, name, props) => {
                          const { payload } = props;
                          if (name === 'Accuracy') return [`${value}% (${payload.attempts} attempts)`, payload.label];
                          return [value, name];
                        }}
                      />
                      {/* Perfect-calibration diagonal rendered as a Line series on a separate dataset */}
                      <Line
                        data={diagonalData}
                        type="linear"
                        dataKey="y"
                        stroke="var(--text-muted)"
                        strokeDasharray="6 3"
                        strokeWidth={1}
                        dot={false}
                        legendType="none"
                        name="Perfect calibration"
                        isAnimationActive={false}
                      />
                      {hasCfa && (
                        <Scatter
                          data={cfaData}
                          fill={DOMAIN_COLOR.cfa}
                          name="CFA confidence bucket"
                        />
                      )}
                      {hasLsat && (
                        <Scatter
                          data={lsatData}
                          fill={DOMAIN_COLOR.lsat}
                          name="LSAT confidence band"
                        />
                      )}
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Panel>
        );
      })()}

      {/* Accuracy by Item Type horizontal bar */}
      {(() => {
        const itemTypeData = (summary?.byItemType || []).map((row) => ({
          name: row.itemType,
          accuracy: row.accuracy ?? 0,
        }));
        return (
          <Panel
            tone="analytics"
            title="Accuracy by Item Type"
            subtitle="Where your accuracy is strongest vs weakest across question/vignette/mock/skill-lab attempts."
          >
            {itemTypeData.length === 0 ? (
              <p className="muted-copy">No item-type data yet — quiz, vignette, mock, and skill-lab attempts will appear here.</p>
            ) : (
              <div style={{ width: '100%', height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={itemTypeData}
                    margin={{ top: 8, right: 24, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      stroke="var(--text-muted)"
                      fontSize={12}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke="var(--text-muted)"
                      fontSize={12}
                      width={90}
                    />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface, #1e293b)', border: '1px solid var(--border)', borderRadius: 8 }}
                      labelStyle={{ color: 'var(--text-secondary)' }}
                      formatter={(value) => [`${value}%`, 'Accuracy']}
                    />
                    <Bar dataKey="accuracy" name="Accuracy %" fill="var(--success, #34d399)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>
        );
      })()}

      <StudyStreakHeatmap
        cfaCounts={cfaHeatCounts}
        lsatCounts={lsatHeatCounts}
        domain={domain}
        lsatReachable={lsatReachable}
      />

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
