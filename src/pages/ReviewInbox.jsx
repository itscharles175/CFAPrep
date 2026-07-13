import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, CalendarClock, Gauge, ListChecks, Wrench } from 'lucide-react';
import { EmptyPanel, MetricCard, PageHeader, ReviewItemCard, SegmentedControl, StatusBadge, Surface } from '../components/ui/Primitives';
import { SkeletonList } from '../components/feedback';
import {
  forecastReviewLoad,
  getReadinessByTopic,
  getReviewInbox,
  getStudyPlan,
  repairVaultData,
  saveStudyPlanSettings,
} from '../lib/learning';
import { getTutorProvider, isTutorEnabledFromEnv } from '../lib/aiTutorContracts';
import { SourceRail } from '../components/SourceContext';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { fetchUnifiedDue, LSAT_REVIEW_PATH } from '../lib/lsatReviewBridge';
import { useScrollRestoration } from '../lib/scrollRestore';
// PSY-13 — ONE global cross-domain ranker over host + LSAT due cards.
import { buildUnifiedDueQueue } from '../lib/dueQueue';
// NAV-1 — durable Study Trail + cross-restart "resume where you left off".
import { recordStudyContext, getResumeTarget, clearResumeHandle } from '../lib/studyTrail';
// PSY-13 — read the Wave-5 ability snapshots to ability-weight the rank (read-only;
// degrades to overdue-only when no snapshot is available).
import { readLatestAbilitySnapshot } from '../lib/psychometrics/abilitySnapshots';

const filters = [
  { value: 'all', label: 'All' },
  { value: 'due-review', label: 'Due' },
  { value: 'weak-objective', label: 'Weak' },
  { value: 'missed-question', label: 'Missed' },
  { value: 'flashcard-review', label: 'Cards' },
  { value: 'mock-review', label: 'Mocks' },
  { value: 'stale-topic', label: 'Stale' },
  { value: 'bookmark', label: 'Bookmarks' },
  { value: 'unfinished-lesson', label: 'Lessons' },
];

// UX-5 — the filter slice names that the `filter` deep-link param accepts. Built
// from the same `filters` list the SegmentedControl renders so the URL contract
// and the UI can't drift. An unknown / absent param falls back to "all".
const VALID_FILTERS = new Set(filters.map((f) => f.value));

export default function ReviewInbox() {
  const [activePathway] = useLevel3Pathway();
  // UX-5 — deep-link support, mirroring the LSAT Review page's `tab` param.
  // `?filter=` opens a specific inbox slice; `?item=` scrolls to + highlights a
  // specific queue item once the list resolves. The filter lives in the URL so
  // the slice is shareable/bookmarkable and survives a refresh, and so the ⌘K
  // palette / cross-domain notification surface can link straight to a slice.
  const [searchParams, setSearchParams] = useSearchParams();
  const filterParam = searchParams.get('filter');
  const deepLinkItemId = searchParams.get('item');
  const [items, setItems] = useState([]);
  const [readiness, setReadiness] = useState([]);
  const [studyPlan, setStudyPlan] = useState(null);
  const [forecast, setForecast] = useState([]);
  // UX-5 — the active slice is DERIVED from the URL (the single source of
  // truth), so a deep-link / ⌘K / back-forward change reflects on the next
  // render without a state-sync effect. `changeFilter` only writes the param.
  const filter = filterParam && VALID_FILTERS.has(filterParam) ? filterParam : 'all';
  // Ref to the deep-linked item's wrapper so we can scroll it into view + flash
  // a highlight once the queue content (not the skeleton) is on screen.
  const deepLinkRef = useRef(null);
  const deepLinkHandled = useRef(false);
  const [message, setMessage] = useState('');
  const [tutorResponse, setTutorResponse] = useState(null);
  const [targetLevel, setTargetLevel] = useState('level1');
  const [dailyTarget, setDailyTarget] = useState('45');
  const [examDate, setExamDate] = useState('');
  const [mockCadence, setMockCadence] = useState('14');
  // LEARN-2 — cross-domain due queue: the LSAT sidecar (:8100) returns its due
  // cards already ability-ranked (overdue DESC, q_type interleave, utility-
  // weighted) on the canonical shape; this inbox merges them with the host's own
  // local Dexie queue into one combined "due today" count. null = not yet loaded.
  const [lsatDue, setLsatDue] = useState(null);
  // PSY-13 — per-plane ability snapshots (Wave-5) feeding the global ranker.
  // null = not yet loaded; {} = loaded but no snapshots (ranker degrades to
  // overdue-only). Read-only consumption of the psychometrics layer.
  const [abilityByPlane, setAbilityByPlane] = useState(null);
  // NAV-1 — the "resume where you left off" target restored across restarts.
  // null = none / not yet resolved; dismissing it clears the boot-readable handle.
  const [resumeTarget, setResumeTarget] = useState(null);

  // UX-1: restore the document scroll position on return to the inbox, incl.
  // after a cross-domain soft-hop (which bypasses native scroll restoration).
  // Gated on the primary study plan resolving so we only jump once the queue's
  // real (deterministic-height) content has replaced the loading skeleton.
  useScrollRestoration('host:/review', { ready: studyPlan != null });

  async function refresh() {
    // LEARN-2: re-pull the unified LSAT due queue alongside the local queue so
    // the combined count stays in sync after a repair / plan save (degrades
    // silently when the sidecar is offline).
    fetchUnifiedDue().then((result) => setLsatDue(result));
    const [nextItems, nextReadiness, nextPlan, nextForecast] = await Promise.all([
      getReviewInbox({ level3Pathway: activePathway }),
      getReadinessByTopic({ level3Pathway: activePathway }),
      getStudyPlan({ level3Pathway: activePathway }),
      forecastReviewLoad(10, new Date(), { level3Pathway: activePathway }),
    ]);
    setItems(nextItems);
    setReadiness(nextReadiness);
    setStudyPlan(nextPlan);
    setForecast(nextForecast);
    setTargetLevel(nextPlan.targetLevel || 'level1');
    setDailyTarget(String(nextPlan.dailyTargetMinutes));
    setExamDate(nextPlan.examDate || '');
    setMockCadence(String(nextPlan.mockCadenceDays || 14));
    if (isTutorEnabledFromEnv() && nextReadiness[0]) {
      const provider = getTutorProvider();
      setTutorResponse(
        await provider.summarizeWeakTopic({
          domain: nextReadiness[0].domain,
          topic: nextReadiness[0].topic,
          sourceIds: [nextReadiness[0].id],
        }),
      );
    } else {
      setTutorResponse(null);
    }
  }

  useEffect(() => {
    let active = true;
    // LEARN-2: pull the unified, ability-ranked LSAT due queue from the sidecar
    // (non-blocking; silently omitted when the backend is offline). Merged with
    // the host's local queue below into one combined due count.
    fetchUnifiedDue().then((result) => {
      if (active) setLsatDue(result);
    });
    Promise.all([
      getReviewInbox({ level3Pathway: activePathway }),
      getReadinessByTopic({ level3Pathway: activePathway }),
      getStudyPlan({ level3Pathway: activePathway }),
      forecastReviewLoad(10, new Date(), { level3Pathway: activePathway }),
    ]).then(
      ([nextItems, nextReadiness, nextPlan, nextForecast]) => {
        if (!active) return;
        setItems(nextItems);
        setReadiness(nextReadiness);
        setStudyPlan(nextPlan);
        setForecast(nextForecast);
        setTargetLevel(nextPlan.targetLevel || 'level1');
        setDailyTarget(String(nextPlan.dailyTargetMinutes));
        setExamDate(nextPlan.examDate || '');
        setMockCadence(String(nextPlan.mockCadenceDays || 14));
        if (isTutorEnabledFromEnv() && nextReadiness[0]) {
          getTutorProvider()
            .summarizeWeakTopic({
              domain: nextReadiness[0].domain,
              topic: nextReadiness[0].topic,
              sourceIds: [nextReadiness[0].id],
            })
            .then((response) => {
              if (active) setTutorResponse(response);
            });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [activePathway]);

  // PSY-13 — load the per-plane ability snapshots once so the global ranker can
  // ability-weight the merged queue. Read-only + fully degrading: a missing /
  // unregistered snapshot store resolves to null per plane and the ranker falls
  // back to overdue-only. Host planes share the host ability plane; LSAT is read
  // separately. Never blocks render.
  useEffect(() => {
    let active = true;
    Promise.all([
      readLatestAbilitySnapshot('cfa'),
      readLatestAbilitySnapshot('lsat'),
    ]).then(([host, lsat]) => {
      if (!active) return;
      const next = {};
      if (host) next.cfa = { theta: host.theta, uncertainty: host.uncertainty };
      if (lsat) next.lsat = { theta: lsat.theta, uncertainty: lsat.uncertainty };
      setAbilityByPlane(next);
    });
    return () => {
      active = false;
    };
  }, []);

  // NAV-1 — on mount, resolve the cross-restart resume target (durable trail →
  // boot-readable handle), THEN record the inbox as the current study context so
  // a later restart can offer to return here. Order matters: read the prior
  // target before overwriting it with this visit. Fully degrading + offline.
  useEffect(() => {
    let active = true;
    getResumeTarget().then((target) => {
      // Don't offer to resume the inbox itself — only a deeper study context.
      if (active && target && target.route !== '/review') setResumeTarget(target);
      void recordStudyContext({
        domain: 'host',
        route: '/review',
        label: 'Review Inbox',
        queryState: filterParam ? { filter: filterParam } : undefined,
      });
    });
    return () => {
      active = false;
    };
    // Record once per mount — the filter param is captured at mount time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NAV-1 — dismiss the resume affordance + clear the boot-readable handle.
  const dismissResume = useCallback(() => {
    clearResumeHandle();
    setResumeTarget(null);
  }, []);

  // UX-5 — filter changes flow through the URL so the active slice is a deep
  // link. We merge into the existing params (preserving any `item` target) and
  // drop the param entirely for the default "all" so the canonical URL stays
  // clean. `replace` avoids stacking a history entry per filter tap.
  const changeFilter = useCallback(
    (next) => {
      setSearchParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          if (next === 'all') merged.delete('filter');
          else merged.set('filter', next);
          return merged;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // A fresh deep-link target (or filter change) should re-run the scroll +
  // highlight below. Only a ref is reset here — the active filter is derived
  // from the URL during render, so there is no filter state to sync.
  useEffect(() => {
    deepLinkHandled.current = false;
  }, [filterParam, deepLinkItemId]);

  async function handleRepair() {
    const preview = await repairVaultData();
    setMessage(`Vault repair complete. ${Object.values(preview.counts).reduce((sum, count) => sum + count, 0)} rows checked.`);
    refresh();
  }

  async function handleSavePlan(event) {
    event.preventDefault();
    await saveStudyPlanSettings({
      targetLevel,
      dailyTargetMinutes: Number(dailyTarget),
      examDate: examDate || null,
      mockCadenceDays: Number(mockCadence),
      restDays: studyPlan?.restDays || [],
    });
    setMessage('Study plan settings saved.');
    refresh();
  }

  const visibleItems = filter === 'all' ? items : items.filter((item) => item.type === filter);

  // UX-5 — once the queue (not the skeleton) is on screen and the deep-linked
  // item is in the visible slice, scroll it into view and flash a highlight.
  // Runs at most once per deep-link (guarded by `deepLinkHandled`) so it doesn't
  // re-scroll on later refreshes/state changes, and it never interferes with the
  // ReviewItemCard's own click → navigate behavior (it only touches its wrapper).
  const deepLinkVisible =
    deepLinkItemId != null && visibleItems.some((item) => item.id === deepLinkItemId);
  useEffect(() => {
    if (deepLinkHandled.current || studyPlan == null || !deepLinkVisible) return;
    const node = deepLinkRef.current;
    if (!node) return;
    deepLinkHandled.current = true;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('review-item-deeplinked');
    const timer = window.setTimeout(() => node.classList.remove('review-item-deeplinked'), 2200);
    return () => window.clearTimeout(timer);
  }, [deepLinkVisible, studyPlan]);

  const weakest = readiness[0];
  // LEARN-2: one combined "due today" count across planes — the host's local
  // queue plus the LSAT sidecar's ability-ranked due cards (0 when the sidecar
  // is offline / unreachable, so the count gracefully reflects host-only).
  const lsatDueCount = lsatDue?.ok ? lsatDue.dueCount : 0;
  const combinedQueueCount = items.length + lsatDueCount;

  // PSY-13 — ONE global ranking over BOTH planes. Replaces the host-first
  // concatenation (host items, then LSAT appended) with a single pure ranker by
  // overdue + ability-weighted utility. Same data sources, unified RANK. Host
  // due-review rows + the LSAT bridge's already-canonical due cards go through
  // `buildUnifiedDueQueue`; with no ability snapshot it degrades to overdue-only.
  const unifiedRanked = buildUnifiedDueQueue(
    {
      hostRows: items
        .filter((item) => item.type === 'due-review')
        .map((item) => ({
          id: item.id,
          title: item.title,
          path: item.path,
          dueAt: item.dueAt,
          topic: item.topic,
          type: item.type,
        })),
      lsatCards: lsatDue?.ok ? lsatDue.items : [],
    },
    { ability: abilityByPlane || undefined, limit: 6 },
  );

  return (
    <div className="page-container">
      <PageHeader
        badge="REVIEW INBOX"
        title="Review Inbox"
        subtitle="Due reviews, weak objectives, missed questions, bookmarks, stale topics, and unfinished lessons in one queue."
        actions={<button className="btn btn-secondary" onClick={handleRepair}><Wrench size={16} /> Repair Vault</button>}
      />

      {/* NAV-1 — cross-restart "resume where you left off". Surfaces the most
          recent study context recorded before the app last closed (durable
          studyTrail store → boot-readable localStorage handle). Dismiss clears
          the handle so it doesn't nag. Offline + degrades to nothing. */}
      {resumeTarget && (
        <Surface tone="vault" status="vault" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'center' }}>
            <div>
              <StatusBadge tone="accent">Resume</StatusBadge>
              <h3 className="qv-mt-3 qv-mb-1">Pick up where you left off</h3>
              <p className="qv-text-secondary qv-fs-sm qv-m-0">{resumeTarget.label}</p>
            </div>
            <div className="qv-flex" style={{ gap: 'var(--space-2)' }}>
              <Link className="btn btn-primary btn-sm" to={resumeTarget.route} onClick={dismissResume}>
                Resume
              </Link>
              <button className="btn btn-secondary btn-sm" onClick={dismissResume}>
                Dismiss
              </button>
            </div>
          </div>
        </Surface>
      )}

      <div className="grid-4 page-metrics">
        <MetricCard label="Due Today" value={studyPlan?.dueToday ?? 0} detail="Scheduled review items" icon={CalendarClock} />
        <MetricCard label="Forecast" value={studyPlan?.forecastReviewCount ?? 0} detail="Next 14 days" icon={Activity} tone="warning" />
        <MetricCard label="Weakest Topic" value={weakest ? `${weakest.readinessScore}%` : '-'} detail={weakest?.topic || 'No attempts yet'} icon={Gauge} tone="success" />
        <MetricCard label="Queue" value={combinedQueueCount} detail={lsatDueCount > 0 ? `${items.length} local + ${lsatDueCount} LSAT` : 'Total actionable items'} icon={ListChecks} tone="accent" />
      </div>

      {/* PSY-13 — ONE global cross-domain due queue: a single ranked list over
          host + LSAT due cards (by overdue + ability-weighted utility), replacing
          the old host-first concatenation. Rendered only when the unified ranker
          has at least one card to interleave (i.e. there ARE cross-domain LSAT
          cards merged in); otherwise the existing per-plane sections below carry
          the single-plane case unchanged. */}
      {unifiedRanked.length > 0 && lsatDue?.ok && lsatDue.items.length > 0 && (
        <Surface tone="analytics" style={{ marginBottom: 'var(--space-6)' }}>
          <StatusBadge tone="accent">Up next — all domains</StatusBadge>
          <h3 className="qv-mt-3">Ranked across every domain</h3>
          <p className="qv-text-secondary qv-fs-sm">
            One queue ranked by how overdue each card is{abilityByPlane && Object.keys(abilityByPlane).length > 0 ? ', weighted by your ability frontier' : ''}.
          </p>
          <ul className="qv-text-secondary qv-fs-sm" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {unifiedRanked.map((card) => {
              const overdueLabel =
                card.overdueDays >= 1 ? `${Math.round(card.overdueDays)}d overdue` : 'due now';
              const body = (
                <span className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'baseline' }}>
                  <span>
                    <StatusBadge tone={card.plane === 'lsat' ? 'study' : 'vault'}>
                      {card.plane.toUpperCase()}
                    </StatusBadge>{' '}
                    {card.title}
                    {card.leech ? <span className="qv-text-muted"> · leech</span> : null}
                  </span>
                  <small className="qv-text-muted">{overdueLabel}</small>
                </span>
              );
              return (
                <li key={card.id} style={{ padding: 'var(--space-2) 0' }}>
                  {card.path ? (
                    card.plane === 'lsat' ? (
                      <a href={card.path} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                        {body}
                      </a>
                    ) : (
                      <Link to={card.path} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
                        {body}
                      </Link>
                    )
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        </Surface>
      )}

      {/* Phase 4.1 — cross-domain: LSAT reviews from the sidecar, merged in.
          Rendered only when the LSAT backend is reachable; the actual review
          happens in the LSAT app (hard nav to /lsat/srs). */}
      {lsatDue?.ok && (
        <Surface tone="study" status="study" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
            <div>
              <StatusBadge tone="study">LSAT</StatusBadge>
              <h3 className="qv-mt-3 qv-mb-2">
                LSAT reviews{lsatDue.dueCount > 0 ? ` — ${lsatDue.dueCount} due` : ' — all caught up'}
              </h3>
              {lsatDue.items.length > 0 ? (
                <ul className="qv-text-secondary qv-fs-sm" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {lsatDue.items.map((it) => (
                    <li key={it.id}>
                      {it.title}
                      {it.qType ? <span className="qv-text-muted"> · {it.qType}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="qv-text-secondary qv-m-0 qv-fs-sm">No LSAT cards are due right now.</p>
              )}
            </div>
            {/* Hard nav — the LSAT SRS flow lives in the LSAT sub-app. */}
            <a className="btn btn-primary btn-sm" href={LSAT_REVIEW_PATH}>
              Review in LSAT Lab
            </a>
          </div>
        </Surface>
      )}

      {studyPlan?.nextActions?.length > 0 && (
        <Surface tone="vault" status="vault" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
            <div>
              <StatusBadge tone="vault">Adaptive task board</StatusBadge>
              <h3 className="qv-mt-3">What To Do Next</h3>
              <p className="qv-text-secondary qv-fs-sm">
                {studyPlan.daysToExam === null ? 'No exam date set.' : `${studyPlan.daysToExam} days to exam.`} Daily target: {studyPlan.dailyTargetMinutes} minutes.
              </p>
            </div>
            <form onSubmit={handleSavePlan} className="planner-form">
              <label>
                <span>Target level</span>
                <select value={targetLevel} onChange={(event) => setTargetLevel(event.target.value)}>
                  <option value="level1">Level I</option>
                  <option value="level2">Level II</option>
                  <option value="level3">Level III</option>
                </select>
              </label>
              <label>
                <span>Daily minutes</span>
                <input type="number" min="10" max="360" value={dailyTarget} onChange={(event) => setDailyTarget(event.target.value)} />
              </label>
              <label>
                <span>Exam date</span>
                <input type="date" value={examDate} onChange={(event) => setExamDate(event.target.value)} />
              </label>
              <label>
                <span>Mock cadence</span>
                <input type="number" min="3" max="60" value={mockCadence} onChange={(event) => setMockCadence(event.target.value)} />
              </label>
              <button className="btn btn-primary" type="submit">Save Plan</button>
            </form>
          </div>
          <div className="cockpit-grid cockpit-grid-2" style={{ marginTop: 'var(--space-5)' }}>
            {studyPlan.nextActions.map((action) => (
              <Link key={`${action.label}:${action.path}`} to={action.path} className="objective-row" style={{ textDecoration: 'none', color: 'inherit' }}>
                <StatusBadge tone="accent">{action.label}</StatusBadge>
                <h3>{action.title}</h3>
                <p className="qv-text-secondary qv-fs-sm">{action.reason}</p>
                {action.reasonDetails?.length > 0 && (
                  <small className="muted-copy">{action.reasonDetails.slice(0, 2).join(' ')}</small>
                )}
              </Link>
            ))}
          </div>
        </Surface>
      )}

      {tutorResponse && !tutorResponse.blockedReason && (
        <Surface tone="study" status="exam" style={{ marginBottom: 'var(--space-6)' }}>
          <StatusBadge tone="accent">Local Tutor</StatusBadge>
          <h3>Weak Topic Summary</h3>
          <p className="qv-text-secondary">{tutorResponse.text}</p>
          <small>Sources: {tutorResponse.sourceIds.join(', ')}</small>
        </Surface>
      )}

      {weakest && (
        <SourceRail
          compact
          title="Weak Topic Source Context"
          subtitle="Official-first snippets mapped to your current review signal."
          target={{
            kind: 'review-item',
            domain: weakest.domain,
            level: studyPlan?.targetLevel || 'level1',
            topicId: weakest.topic?.split(':').at(-1) || weakest.topic,
            pathway: weakest.topic?.startsWith('level3:') ? activePathway : undefined,
            title: weakest.title || weakest.topic,
            objectiveIds: [weakest.learningObjective].filter(Boolean),
            keywords: [weakest.reason, weakest.topic, weakest.title].filter(Boolean),
            route: weakest.path || '/review',
          }}
        />
      )}

      <Surface tone="analytics" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Review Forecast</h3>
        <div className="forecast-strip">
          {forecast.map((day) => (
            <div key={day.date}>
              <small>{day.date.slice(5)}</small>
              <strong>{day.count}</strong>
            </div>
          ))}
        </div>
      </Surface>

      {/* UX-5: filter changes route through `changeFilter`, which mirrors the
          slice into the `?filter=` deep-link param. */}
      <SegmentedControl label="Review inbox filter" options={filters} value={filter} onChange={changeFilter} />
      {message && <p className="muted-copy">{message}</p>}

      {/* UX-1: reserve a deterministic min-height for the queue so the
          loading → empty/populated transitions don't shift the page (no CLS),
          and show the shared SkeletonList while the first load resolves. The
          studyPlan gate doubles as the "primary data loaded" signal. */}
      <div className="review-list" style={{ minHeight: '12rem' }}>
        {studyPlan == null ? (
          <SkeletonList rows={4} />
        ) : visibleItems.length ? (
          visibleItems.map((item) =>
            // UX-5: wrap only the deep-linked item in a marker div so we have a
            // scroll/highlight target (`deepLinkRef`). The card itself is
            // unchanged — its Link click still navigates as before. The wrapper
            // is a normal grid item carrying the highlight ring; the contained
            // card keeps its own layout.
            item.id === deepLinkItemId ? (
              <div key={item.id} ref={deepLinkRef} className="review-item-deeplink-target">
                <ReviewItemCard item={item} />
              </div>
            ) : (
              <ReviewItemCard key={item.id} item={item} />
            ),
          )
        ) : (
          <EmptyPanel title="No items in this slice yet" description="Complete a lesson or quiz to populate the queue." tone="vault" />
        )}
      </div>
    </div>
  );
}
