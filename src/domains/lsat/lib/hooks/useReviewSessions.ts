import { useQueries } from "@tanstack/react-query";
import { api } from "../api";
import type { ResultItem, SessionSummary } from "../types";

const MAX_SESSIONS = 8;

/** Fetch results for multiple sessions (for review queue + gap compare). */
export function useMultiSessionResults(sessionIds: number[]) {
  const ids = sessionIds.slice(0, MAX_SESSIONS);
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["results", id],
      // A result row is learner-owned evidence. Never replace a failed request
      // with the development fixture: doing so made an offline session look
      // like a real attempt and polluted review queues and analytics.
      queryFn: () => api.sessionResults(id),
      staleTime: 30_000,
      enabled: id > 0,
    })),
  });

  const resultsBySessionId = new Map<number, ResultItem[]>();
  const unavailableSessionIds: number[] = [];
  ids.forEach((id, i) => {
    const q = queries[i];
    if (q.data) {
      // Cached/live data remains valid evidence even if a later refresh fails.
      resultsBySessionId.set(id, q.data.items);
    } else if (q.isError) {
      unavailableSessionIds.push(id);
    }
  });

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.length > 0 && queries.every((q) => q.isError);

  return {
    resultsBySessionId,
    // Consumers retain the established all-failed error behavior, while the
    // additive list lets them disclose a partial result set without inventing
    // data for unavailable sessions.
    unavailableSessionIds,
    hasUnavailableResults: unavailableSessionIds.length > 0,
    isLoading,
    isError,
    queries,
  };
}

export function reviewableSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((s) => s.ended != null || s.scaled_score != null)
    .slice(0, MAX_SESSIONS);
}
