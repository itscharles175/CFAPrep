import { useCallback, useEffect, useState } from 'react';
import type { StudyWorkspace } from '../routes/routeManifest';

export type StudyDomain = 'cfa' | 'lsat' | 'quant' | 'excel';
export type CfaTargetLevel = 'level1' | 'level2' | 'level3';
export type StudyGoal = 'balanced' | 'exam-readiness' | 'retention' | 'skill-building';

export interface StudyContext {
  domain: StudyDomain;
  cfaLevel: CfaTargetLevel;
  goal: StudyGoal;
}

export const STUDY_CONTEXT_STORAGE_KEY = 'studyvault:study-context:v1';
export const STUDY_CONTEXT_EVENT = 'studyvault:study-context-change';
export const STUDY_CONTEXT_RETURN_STORAGE_KEY = 'studyvault:study-context-returns:v1';
/**
 * A one-hop handoff protects a deliberately selected curriculum while the
 * unified root swaps the LSAT and host route trees. The destination consumes it
 * synchronously before any old-plane effect can re-hydrate stale context.
 */
export const STUDY_CONTEXT_HANDOFF_STORAGE_KEY = 'studyvault:study-context-handoff:v1';
/** The source curriculum offered from first-time LSAT setup. */
export const STUDY_CONTEXT_ORIGIN_STORAGE_KEY = 'studyvault:study-context-origin:v1';

export const DEFAULT_STUDY_CONTEXT: StudyContext = {
  domain: 'cfa',
  cfaLevel: 'level1',
  goal: 'balanced',
};

const DOMAINS: readonly StudyDomain[] = ['cfa', 'lsat', 'quant', 'excel'];
const CFA_LEVELS: readonly CfaTargetLevel[] = ['level1', 'level2', 'level3'];
const GOALS: readonly StudyGoal[] = ['balanced', 'exam-readiness', 'retention', 'skill-building'];

type WorkspaceReturns = Partial<Record<StudyWorkspace, string>>;
type StudyContextReturns = Partial<Record<StudyDomain, WorkspaceReturns>>;

export interface StudyContextOrigin {
  context: StudyContext;
  route: string;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function normalizeStudyContext(value: unknown): StudyContext {
  const candidate = value && typeof value === 'object' ? (value as Partial<StudyContext>) : {};
  return {
    domain: includes(DOMAINS, candidate.domain) ? candidate.domain : DEFAULT_STUDY_CONTEXT.domain,
    cfaLevel: includes(CFA_LEVELS, candidate.cfaLevel) ? candidate.cfaLevel : DEFAULT_STUDY_CONTEXT.cfaLevel,
    goal: includes(GOALS, candidate.goal) ? candidate.goal : DEFAULT_STUDY_CONTEXT.goal,
  };
}

export function readStudyContext(storage: Storage | null | undefined = globalThis?.localStorage): StudyContext {
  try {
    const raw = storage?.getItem(STUDY_CONTEXT_STORAGE_KEY);
    return raw ? normalizeStudyContext(JSON.parse(raw)) : DEFAULT_STUDY_CONTEXT;
  } catch {
    return DEFAULT_STUDY_CONTEXT;
  }
}

export function writeStudyContext(
  patch: Partial<StudyContext>,
  storage: Storage | null | undefined = globalThis?.localStorage,
): StudyContext {
  const next = normalizeStudyContext({ ...readStudyContext(storage), ...patch });
  try {
    storage?.setItem(STUDY_CONTEXT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private/restricted contexts retain the valid in-memory selection.
  }
  try {
    globalThis?.dispatchEvent?.(new CustomEvent(STUDY_CONTEXT_EVENT, { detail: next }));
  } catch {
    // Server-side and test runtimes do not require cross-component events.
  }
  return next;
}

/** Stage a chosen context across a host ⇄ LSAT route-tree replacement. */
export function stageStudyContextHandoff(
  context: StudyContext,
  storage: Storage | null | undefined = globalThis?.sessionStorage,
): void {
  try {
    storage?.setItem(STUDY_CONTEXT_HANDOFF_STORAGE_KEY, JSON.stringify(normalizeStudyContext(context)));
  } catch {
    // Local storage remains the fallback when session storage is unavailable.
  }
}

/**
 * Consume a staged selection on the destination tree and immediately make it
 * canonical. Consuming once avoids replaying an old navigation after Back.
 */
export function consumeStudyContextHandoff(
  handoffStorage: Storage | null | undefined = globalThis?.sessionStorage,
  contextStorage: Storage | null | undefined = globalThis?.localStorage,
): StudyContext | null {
  try {
    const raw = handoffStorage?.getItem(STUDY_CONTEXT_HANDOFF_STORAGE_KEY);
    handoffStorage?.removeItem(STUDY_CONTEXT_HANDOFF_STORAGE_KEY);
    if (!raw) return null;
    const context = normalizeStudyContext(JSON.parse(raw));
    writeStudyContext(context, contextStorage);
    return context;
  } catch {
    return null;
  }
}

export function domainForLocation(pathname: string): StudyDomain | null {
  if (pathname === '/cfa' || pathname.startsWith('/cfa/')) return 'cfa';
  if (pathname === '/lsat' || pathname.startsWith('/lsat/')) return 'lsat';
  if (pathname === '/quant' || pathname.startsWith('/quant/')) return 'quant';
  if (pathname === '/excel' || pathname.startsWith('/excel/')) return 'excel';
  return null;
}

export function workspaceHref(workspace: StudyWorkspace, context: StudyContext): string {
  if (workspace === 'today') return '/';
  if (workspace === 'review') return context.domain === 'lsat' ? '/lsat/review' : '/review';
  if (workspace === 'progress') return context.domain === 'lsat' ? '/lsat/analytics' : '/analytics';
  if (workspace === 'library') return '/vault';
  if (workspace === 'practice') {
    if (context.domain === 'cfa') return `/cfa/${context.cfaLevel}/mock`;
    if (context.domain === 'lsat') return '/lsat/practice';
    // These are real, saved-attempt practice surfaces — not the dashboard that
    // the Learn workspace already owns. Keeping the destinations distinct makes
    // the workspace labels honest for the applied Quant and Excel tracks.
    return context.domain === 'quant' ? '/quant/risk-management' : '/excel/dcf-modeling';
  }
  if (workspace === 'learn') return context.domain === 'lsat' ? '/lsat/dashboard' : `/${context.domain}`;
  return '/preferences';
}

function isSafeLocalRoute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('://');
}

/** Remember the curriculum and exact route that led into first-time LSAT setup. */
export function stageStudyContextOrigin(
  context: StudyContext,
  route: string,
  storage: Storage | null | undefined = globalThis?.sessionStorage,
): void {
  if (!isSafeLocalRoute(route)) return;
  try {
    storage?.setItem(
      STUDY_CONTEXT_ORIGIN_STORAGE_KEY,
      JSON.stringify({ context: normalizeStudyContext(context), route } satisfies StudyContextOrigin),
    );
  } catch {
    // Returning remains optional when session storage is unavailable.
  }
}

export function readStudyContextOrigin(
  storage: Storage | null | undefined = globalThis?.sessionStorage,
): StudyContextOrigin | null {
  try {
    const raw = storage?.getItem(STUDY_CONTEXT_ORIGIN_STORAGE_KEY);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<StudyContextOrigin>;
    if (!isSafeLocalRoute(candidate?.route)) return null;
    return { context: normalizeStudyContext(candidate.context), route: candidate.route };
  } catch {
    return null;
  }
}

export function clearStudyContextOrigin(
  storage: Storage | null | undefined = globalThis?.sessionStorage,
): void {
  try {
    storage?.removeItem(STUDY_CONTEXT_ORIGIN_STORAGE_KEY);
  } catch {
    // Nothing to clean up in restricted storage contexts.
  }
}

function readStudyContextReturns(storage: Storage | null | undefined = globalThis?.localStorage): StudyContextReturns {
  try {
    const raw = storage?.getItem(STUDY_CONTEXT_RETURN_STORAGE_KEY);
    if (!raw) return {};
    const candidate = JSON.parse(raw);
    if (!candidate || typeof candidate !== 'object') return {};
    return Object.fromEntries(
      DOMAINS.flatMap((domain) => {
        const entries = candidate[domain];
        if (!entries || typeof entries !== 'object') return [];
        const safeEntries = Object.entries(entries).filter(
          ([workspace, path]) => workspace in ({ today: true, learn: true, practice: true, review: true, progress: true, library: true, utility: true }) && isSafeLocalRoute(path),
        );
        return safeEntries.length ? [[domain, Object.fromEntries(safeEntries)]] : [];
      }),
    ) as StudyContextReturns;
  } catch {
    return {};
  }
}

/** Remember the last concrete route for one domain/workspace pair. */
export function rememberStudyContextRoute(
  domain: StudyDomain,
  workspace: StudyWorkspace,
  path: string,
  storage: Storage | null | undefined = globalThis?.localStorage,
): void {
  if (!isSafeLocalRoute(path)) return;
  const current = readStudyContextReturns(storage);
  const next: StudyContextReturns = {
    ...current,
    [domain]: { ...current[domain], [workspace]: path },
  };
  try {
    storage?.setItem(STUDY_CONTEXT_RETURN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Route return points are a convenience; navigation remains deterministic.
  }
}

/** Return a saved route only when it belongs to the requested curriculum/workspace. */
export function studyContextReturnHref(
  domain: StudyDomain,
  workspace: StudyWorkspace,
  storage: Storage | null | undefined = globalThis?.localStorage,
): string | null {
  return readStudyContextReturns(storage)[domain]?.[workspace] ?? null;
}

/** Resolve a curriculum switch to the same workspace, preferring its last route. */
export function contextSwitchHref(
  workspace: StudyWorkspace,
  context: StudyContext,
  storage: Storage | null | undefined = globalThis?.localStorage,
): string {
  return studyContextReturnHref(context.domain, workspace, storage) ?? workspaceHref(workspace, context);
}

export function useStudyContext(): [StudyContext, (patch: Partial<StudyContext>) => StudyContext] {
  const [context, setContext] = useState<StudyContext>(() => consumeStudyContextHandoff() ?? readStudyContext());

  useEffect(() => {
    const handleContext = (event: Event) => setContext(normalizeStudyContext((event as CustomEvent).detail));
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STUDY_CONTEXT_STORAGE_KEY) setContext(readStudyContext());
    };
    window.addEventListener(STUDY_CONTEXT_EVENT, handleContext);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(STUDY_CONTEXT_EVENT, handleContext);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const update = useCallback((patch: Partial<StudyContext>) => {
    const next = writeStudyContext(patch);
    setContext(next);
    return next;
  }, []);
  return [context, update];
}
