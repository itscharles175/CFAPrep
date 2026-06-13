import { useQueries } from "@tanstack/react-query";
import { api } from "../api";
import { setOfflineMode } from "../offline";
import * as sample from "../sample";
import type { ResultItem, SessionSummary } from "../types";

const MAX_SESSIONS = 8;

/** Fetch results for multiple sessions (for review queue + gap compare). */
export function useMultiSessionResults(sessionIds: number[]) {
  const ids = sessionIds.slice(0, MAX_SESSIONS);
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["results", id],
      queryFn: async () => {
        try {
          const data = await api.sessionResults(id);
          setOfflineMode(false);
          return data;
        } catch {
          setOfflineMode(true);
          if (id === 999) return sample.sampleResults;
          return {
            ...sample.sampleResults,
            session: { id, type: "section" as const, started: new Date().toISOString() },
            items: sample.sampleResults.items.map((it, i) => ({
              ...it,
              question: { ...it.question, id: id * 100 + i },
            })),
          };
        }
      },
      staleTime: 30_000,
      enabled: id > 0,
    })),
  });

  const resultsBySessionId = new Map<number, ResultItem[]>();
  ids.forEach((id, i) => {
    const q = queries[i];
    if (q.data) resultsBySessionId.set(id, q.data.items);
  });

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.length > 0 && queries.every((q) => q.isError);

  return { resultsBySessionId, isLoading, isError, queries };
}

export function reviewableSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((s) => s.ended != null || s.scaled_score != null)
    .slice(0, MAX_SESSIONS);
}
