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

export const DEFAULT_STUDY_CONTEXT: StudyContext = {
  domain: 'cfa',
  cfaLevel: 'level1',
  goal: 'balanced',
};

const DOMAINS: readonly StudyDomain[] = ['cfa', 'lsat', 'quant', 'excel'];
const CFA_LEVELS: readonly CfaTargetLevel[] = ['level1', 'level2', 'level3'];
const GOALS: readonly StudyGoal[] = ['balanced', 'exam-readiness', 'retention', 'skill-building'];

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
    return context.domain === 'quant' ? '/quant' : '/excel';
  }
  if (workspace === 'learn') return `/${context.domain}`;
  return '/preferences';
}

export function useStudyContext(): [StudyContext, (patch: Partial<StudyContext>) => void] {
  const [context, setContext] = useState<StudyContext>(() => readStudyContext());

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

  const update = useCallback((patch: Partial<StudyContext>) => setContext(writeStudyContext(patch)), []);
  return [context, update];
}
