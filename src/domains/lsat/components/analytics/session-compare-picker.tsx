import { AnalyticsProvider } from "./analytics-context";
import { SessionCompare } from "./SessionCompare";
import type { SessionSummary } from "@/lib/types";

/** R4-B4 — pick any two sessions for timing compare. */
export function SessionComparePicker({
  sessions,
}: {
  sessions: SessionSummary[];
}) {
  if (sessions.length < 2) return null;

  return (
    <AnalyticsProvider
      value={{ source: "all", range: "all", comparePrior: false }}
    >
      <SessionCompare sessions={sessions} />
    </AnalyticsProvider>
  );
}
