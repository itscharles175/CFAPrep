/**
 * LEARN-3 — unified daily plan section (host side).
 *
 * The LSAT backend's `GET /api/study/today?include_host=true` returns ONE daily
 * plan that merges the LSAT SRS/drill/pacing breakdown with the host's
 * weakest-by-ability planes (CFA/Quant/Excel), reranked by a single
 * cross-domain utility score and packed to the merged DATA-6 SharedStudyProfile
 * budget. The host can't reach the LSAT React app (separate top-level branch)
 * but it CAN reach the sidecar over HTTP, so this component fetches the merged
 * plan directly and renders it — full on /today, a compact subset on the
 * dashboard.
 *
 * Fully degrading (mirrors `lsatReviewBridge.ts` / `studyProfileBridge.ts`): any
 * failure (sidecar down, timeout, shape drift) NEVER throws — the section simply
 * renders nothing (or an unobtrusive offline note in `full` mode) so a missing
 * sidecar never blocks the host's local-first plan above it.
 *
 * DATA-1: `/api/study/today` is present in the generated OpenAPI path map. The
 * body is still parsed defensively because the section must degrade cleanly if a
 * user runs an older or unreachable sidecar.
 */
import { useEffect, useState } from 'react';
import { GraduationCap, BrainCircuit, Table2, BookOpen, Layers, Inbox, RefreshCw, Target, Timer } from 'lucide-react';
import { Surface, StatusBadge, InlineCluster } from '../ui/Primitives';
import { fetchLsatSidecarJson } from '../../lib/lsatSidecarClient';
import type { paths } from '../../domains/lsat/lib/api.gen';

const STUDY_TODAY_PATH = '/api/study/today' satisfies keyof paths;
/** Deep-link into the LSAT app for an LSAT-native task (host hard-navigates). */
const LSAT_DOMAIN_PATH = '/lsat';

/** Host plane -> in-app route + display label for a `host_drill` task. */
const HOST_PLANE_ROUTE: Record<string, string> = {
  cfa: '/cfa',
  quant: '/quant',
  excel: '/excel',
};
const HOST_PLANE_LABEL: Record<string, string> = {
  cfa: 'CFA',
  quant: 'Quant',
  excel: 'Excel',
};

/** One task in the merged plan, projected to the host's display vocabulary. */
export interface UnifiedPlanTask {
  /** Backend task type (`srs` | `leech` | `concept_gap` | `drill` | `pacing` | `host_drill` | `section`). */
  type: string;
  /** Which domain this task exercises (`lsat` for native tasks, the plane for host drills). */
  domain: 'lsat' | 'cfa' | 'quant' | 'excel';
  label: string;
  estMinutes: number | null;
  /** Cross-domain utility score the whole list was reranked by (0..~1.2). */
  utilityScore: number | null;
  /** In-app route (`/cfa` …) or LSAT deep-link target for the task. */
  path: string;
  /** True for the LSAT branch (host must hard-navigate, not soft-route). */
  external: boolean;
}

export interface UnifiedPlan {
  /** True only when the backend actually merged the host plane. */
  includeHost: boolean;
  planesMerged: string[];
  hostTaskCount: number;
  /** `"shared_profile"` when the DATA-6 budget sized the day, else `"study_plan"`. */
  budgetSource: string;
  minutesBudget: number | null;
  estimatedMinutes: number | null;
  intensity: string | null;
  tasks: UnifiedPlanTask[];
}

export interface UnifiedPlanResult {
  /** True when the sidecar answered a 2xx with a parseable merged plan. */
  ok: boolean;
  /** True when the value came from the backend (vs an unreachable sidecar). */
  fromBackend: boolean;
  plan: UnifiedPlan | null;
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function taskFromRaw(raw: unknown): UnifiedPlanTask | null {
  if (!isRecord(raw)) return null;
  const type = str(raw.type);
  if (!type) return null;
  // host_drill rows carry their plane in `domain`; everything else is LSAT-native.
  const rawDomain = str(raw.domain).toLowerCase();
  const isHost = type === 'host_drill' && rawDomain in HOST_PLANE_ROUTE;
  const domain = (isHost ? rawDomain : 'lsat') as UnifiedPlanTask['domain'];
  return {
    type,
    domain,
    label: str(raw.label) || (isHost ? `Drill ${HOST_PLANE_LABEL[domain]}` : 'Study task'),
    estMinutes: num(raw.est_minutes),
    utilityScore: num(raw.utility_score),
    path: isHost ? HOST_PLANE_ROUTE[domain] : LSAT_DOMAIN_PATH,
    external: !isHost,
  };
}

function planFromRaw(raw: unknown): UnifiedPlan | null {
  if (!isRecord(raw)) return null;
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks = rawTasks.map(taskFromRaw).filter((t): t is UnifiedPlanTask => t !== null);
  const planes = Array.isArray(raw.planes_merged)
    ? raw.planes_merged.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    includeHost: raw.include_host === true,
    planesMerged: planes,
    hostTaskCount: num(raw.host_task_count) ?? tasks.filter((t) => t.type === 'host_drill').length,
    budgetSource: str(raw.budget_source) || 'study_plan',
    minutesBudget: num(raw.minutes_budget),
    estimatedMinutes: num(raw.estimated_minutes),
    intensity: str(raw.intensity) || null,
    tasks,
  };
}

/**
 * Fetch the merged cross-domain daily plan from the LSAT sidecar. Never throws:
 * any failure degrades to `{ ok: false, fromBackend: false, plan: null }` so the
 * caller can simply omit the section.
 */
export async function fetchUnifiedPlan(
  opts: { timeoutMs?: number } = {},
): Promise<UnifiedPlanResult> {
  const { timeoutMs = 3000 } = opts;
  const res = await fetchLsatSidecarJson(`${STUDY_TODAY_PATH}?include_host=true`, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  if (!res.reachable) {
    return {
      ok: false,
      fromBackend: false,
      plan: null,
      error: res.error,
    };
  }
  if (!res.ok) {
    return { ok: false, fromBackend: false, plan: null, error: `Sidecar responded ${res.status}.` };
  }
  if (res.data == null) {
    return { ok: false, fromBackend: false, plan: null, error: 'Unparseable plan body.' };
  }
  const plan = planFromRaw(res.data);
  if (!plan) {
    return { ok: false, fromBackend: false, plan: null, error: 'Unexpected plan shape.' };
  }
  return { ok: true, fromBackend: true, plan };
}

function iconForTask(task: UnifiedPlanTask, size: number) {
  if (task.type === 'host_drill') {
    if (task.domain === 'cfa') return <GraduationCap size={size} aria-hidden="true" />;
    if (task.domain === 'quant') return <BrainCircuit size={size} aria-hidden="true" />;
    if (task.domain === 'excel') return <Table2 size={size} aria-hidden="true" />;
    return <BookOpen size={size} aria-hidden="true" />;
  }
  if (task.type === 'srs' || task.type === 'leech') return <Inbox size={size} aria-hidden="true" />;
  if (task.type === 'pacing') return <Timer size={size} aria-hidden="true" />;
  return <Target size={size} aria-hidden="true" />;
}

function toneForTask(task: UnifiedPlanTask): string {
  if (task.type === 'host_drill') return task.domain === 'cfa' ? 'exam' : task.domain === 'quant' ? 'quant' : 'excel';
  if (task.type === 'srs' || task.type === 'leech') return 'warning';
  return 'study';
}

function TaskRow({ task }: { task: UnifiedPlanTask }) {
  const tone = toneForTask(task);
  const planeBadge =
    task.type === 'host_drill' ? HOST_PLANE_LABEL[task.domain] || task.domain.toUpperCase() : 'LSAT';
  // Host plane drills soft-route within the host app; LSAT tasks hard-navigate
  // into the separate LSAT branch.
  const commonStyle = {
    gap: 'var(--space-3)',
    alignItems: 'center',
    textDecoration: 'none',
    color: 'inherit',
  } as const;
  // Both LSAT (separate top-level branch — hard nav) and host plane routes use a
  // real anchor so modifier/middle-click + a11y work; the host router intercepts
  // a plain left-click on in-app routes and soft-routes it.
  return (
    <a href={task.path} className="flex-between qv-card" style={commonStyle}>
      <span className="qv-row-3" style={{ alignItems: 'center', minWidth: 0 }}>
        <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.85 }}>{iconForTask(task, 18)}</span>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: 'block' }}>{task.label}</strong>
          {task.estMinutes != null && (
            <small className="muted-copy">~{Math.round(task.estMinutes)} min</small>
          )}
        </span>
      </span>
      <StatusBadge tone={tone}>{planeBadge}</StatusBadge>
    </a>
  );
}

interface UnifiedPlanSectionProps {
  /** `full` for the /today page (header + all merged tasks); `compact` for the
   *  dashboard (badge row + the top N tasks, no offline note). */
  variant?: 'full' | 'compact';
  /** Cap the rendered task list (compact dashboards want a small subset). */
  maxTasks?: number;
}

/**
 * Renders the merged cross-domain daily plan. Self-contained: fetches on mount,
 * degrades silently when the sidecar is unreachable. Renders NOTHING until the
 * fetch resolves so it never reserves space for a section that may be empty
 * (the host's own local plan is the primary surface above it).
 */
export default function UnifiedPlanSection({ variant = 'full', maxTasks }: UnifiedPlanSectionProps) {
  const [result, setResult] = useState<UnifiedPlanResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    fetchUnifiedPlan()
      .then((r) => {
        if (active) setResult(r);
      })
      .catch(() => {
        if (active) setResult({ ok: false, fromBackend: false, plan: null });
      });
    return () => {
      active = false;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await fetchUnifiedPlan();
      setResult(r);
    } finally {
      setRefreshing(false);
    }
  }

  // Still loading — render nothing (the host's local plan carries the page).
  if (result === null) return null;

  // Sidecar unreachable: compact mode omits the section entirely; full mode
  // shows a single unobtrusive line so the user knows cross-domain merging is off.
  if (!result.ok || !result.plan) {
    if (variant === 'compact') return null;
    return (
      <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-6)' }}>
        <InlineCluster>
          <Layers size={16} aria-hidden="true" />
          <span className="muted-copy qv-fs-sm">
            Cross-domain plan unavailable — start the LSAT backend to merge CFA/Quant/Excel into today.
          </span>
        </InlineCluster>
      </Surface>
    );
  }

  const plan = result.plan;
  // Nothing meaningful to merge (no host evidence yet) — keep the page clean.
  if (!plan.includeHost || plan.hostTaskCount === 0) {
    return null;
  }

  const tasks = typeof maxTasks === 'number' ? plan.tasks.slice(0, maxTasks) : plan.tasks;
  const planeBadges = plan.planesMerged.map((p) => HOST_PLANE_LABEL[p] || p.toUpperCase());

  if (variant === 'compact') {
    return (
      <Surface tone="study" density="compact" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="flex-between qv-row-3" style={{ alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent" icon={Layers}>One plan, all domains</StatusBadge>
            <p className="muted-copy qv-fs-sm" style={{ margin: 'var(--space-1) 0 0' }}>
              {plan.hostTaskCount} cross-domain task{plan.hostTaskCount === 1 ? '' : 's'} merged
              {planeBadges.length ? ` from ${planeBadges.join(' · ')}` : ''}.
            </p>
          </div>
          <a href="/today" className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }}>
            Open Today
          </a>
        </div>
        <ul className="qv-stack-2 qv-mt-3" style={{ listStyle: 'none', padding: 0, marginBottom: 0 }}>
          {tasks.map((task, i) => (
            <li key={`${task.type}-${task.domain}-${i}`}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
      </Surface>
    );
  }

  return (
    <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
      <div className="flex-between qv-row-3-start" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <div>
          <StatusBadge tone="accent" icon={Layers}>Unified plan — all domains</StatusBadge>
          <h3 className="qv-mt-2" style={{ marginBottom: 0 }}>One day across LSAT + {planeBadges.join(', ') || 'host'}</h3>
          <p className="muted-copy qv-mt-1" style={{ marginBottom: 0 }}>
            Reranked by cross-domain utility · {plan.hostTaskCount} cross-domain task
            {plan.hostTaskCount === 1 ? '' : 's'} folded in
            {plan.minutesBudget != null
              ? ` · budget ${plan.minutesBudget} min${plan.budgetSource === 'shared_profile' ? ' (shared profile)' : ''}`
              : ''}
            .
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={refresh} disabled={refreshing} style={{ flexShrink: 0 }}>
          <RefreshCw size={14} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <ul className="qv-stack-2 qv-mt-3" style={{ listStyle: 'none', padding: 0, marginBottom: 0 }}>
        {tasks.map((task, i) => (
          <li key={`${task.type}-${task.domain}-${i}`}>
            <TaskRow task={task} />
          </li>
        ))}
      </ul>
    </Surface>
  );
}
