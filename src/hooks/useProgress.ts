import { useEffect, useState } from 'react';
import {
  emptyProgressSummary,
  getLessonProgress,
  progressSummaryQuery,
  recordModuleVisit,
  subscribeProgressChanges,
  toggleModuleCompleted,
} from '../lib/learning';
// UX-6 — the cross-domain notification fold lives directly in progressStore (the
// `../lib/learning` barrel doesn't re-export it, and that barrel is owned by a
// sibling item); importing the source module keeps this hook self-contained.
import {
  emptyCrossDomainNotificationSummary,
  getCrossDomainUpcomingReviews,
  type CrossDomainNotificationSummary,
} from '../lib/progressStore';
import type { DomainId, LessonProgress } from '../lib/learningTypes';

export type ProgressSummary = typeof emptyProgressSummary;

export function useProgressSummary(): ProgressSummary {
  const [summary, setSummary] = useState<ProgressSummary>(emptyProgressSummary);

  useEffect(() => {
    const subscription = progressSummaryQuery().subscribe({
      next: setSummary,
      error: () => setSummary(emptyProgressSummary),
    });

    return () => subscription.unsubscribe();
  }, []);

  return summary;
}

export interface ModuleProgressInput {
  domain: DomainId;
  moduleId: string;
  title: string;
  path: string;
}

export interface ModuleProgressResult {
  progress: LessonProgress | null;
  completed: boolean;
  toggleComplete: () => Promise<void>;
}

export function useModuleProgress({ domain, moduleId, title, path }: ModuleProgressInput): ModuleProgressResult {
  const [progress, setProgress] = useState<LessonProgress | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (!domain || !moduleId) return;
      const row = await recordModuleVisit({ domain, moduleId, title, path });
      if (!cancelled) setProgress(row ?? null);
    }

    refresh();

    const handleProgressChange = async () => {
      const row = await getLessonProgress(domain, moduleId);
      if (!cancelled) setProgress(row ?? null);
    };

    const unsubscribe = subscribeProgressChanges(handleProgressChange);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [domain, moduleId, title, path]);

  async function toggleComplete() {
    const row = await toggleModuleCompleted({ domain, moduleId, title, path });
    setProgress(row ?? null);
  }

  return {
    progress,
    completed: Boolean(progress?.completed),
    toggleComplete,
  };
}

export interface CrossDomainNotificationsState extends CrossDomainNotificationSummary {
  /** True until the first fold resolves (host + sidecar legs settled). */
  loading: boolean;
}

/**
 * UX-6 — the proactive cross-domain due-nudge backing the TopBar bell popover and
 * the {@link NotificationCenter}. Folds the host's local due reviews together with
 * the LSAT sidecar's ability-ranked queue (LEARN-2), refreshing whenever local
 * progress changes (a quiz/review writes to Dexie → `subscribeProgressChanges`).
 *
 * Degrades by contract: the sidecar being down just drops the LSAT rows
 * (`lsatAvailable: false`) and a failed Dexie read drops the host rows
 * (`indexedDbAvailable: false`) — the hook never throws, so the bell always has
 * something to render.
 *
 * `pollMs` (default off) optionally re-folds on an interval so a sidecar that
 * comes back up is picked up without a local write; pass `0`/omit to refresh
 * only on progress changes.
 */
export function useCrossDomainNotifications(options: { limit?: number; pollMs?: number } = {}): CrossDomainNotificationsState {
  const { limit = 5, pollMs = 0 } = options;
  const [summary, setSummary] = useState<CrossDomainNotificationSummary>(emptyCrossDomainNotificationSummary);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const next = await getCrossDomainUpcomingReviews({ limit });
        if (!cancelled) setSummary(next);
      } catch {
        // getCrossDomainUpcomingReviews degrades internally; this guards an
        // unexpected throw so a transient failure never blanks the surface.
        if (!cancelled) setSummary(emptyCrossDomainNotificationSummary);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    refresh();
    const unsubscribe = subscribeProgressChanges(refresh);
    const timer = pollMs > 0 ? setInterval(refresh, pollMs) : null;

    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearInterval(timer);
    };
  }, [limit, pollMs]);

  return { ...summary, loading };
}
