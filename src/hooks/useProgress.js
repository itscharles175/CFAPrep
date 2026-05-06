import { useEffect, useState } from 'react';
import {
  emptyProgressSummary,
  getLessonProgress,
  progressSummaryQuery,
  recordModuleVisit,
  subscribeProgressChanges,
  toggleModuleCompleted,
} from '../lib/learning';

export function useProgressSummary() {
  const [summary, setSummary] = useState(emptyProgressSummary);

  useEffect(() => {
    const subscription = progressSummaryQuery().subscribe({
      next: setSummary,
      error: () => setSummary(emptyProgressSummary),
    });

    return () => subscription.unsubscribe();
  }, []);

  return summary;
}

export function useModuleProgress({ domain, moduleId, title, path }) {
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (!domain || !moduleId) return;
      const row = await recordModuleVisit({ domain, moduleId, title, path });
      if (!cancelled) setProgress(row);
    }

    refresh();

    const handleProgressChange = async () => {
      const row = await getLessonProgress(domain, moduleId);
      if (!cancelled) setProgress(row);
    };

    const unsubscribe = subscribeProgressChanges(handleProgressChange);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [domain, moduleId, title, path]);

  async function toggleComplete() {
    const row = await toggleModuleCompleted({ domain, moduleId, title, path });
    setProgress(row);
  }

  return {
    progress,
    completed: Boolean(progress?.completed),
    toggleComplete,
  };
}
