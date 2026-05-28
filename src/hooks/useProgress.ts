import { useEffect, useState } from 'react';
import {
  emptyProgressSummary,
  getLessonProgress,
  progressSummaryQuery,
  recordModuleVisit,
  subscribeProgressChanges,
  toggleModuleCompleted,
} from '../lib/learning';
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
