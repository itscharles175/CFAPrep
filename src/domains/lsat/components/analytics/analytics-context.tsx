import { createContext, useContext } from "react";
import type { QType } from "@lsat/lib/types";
import type { AnalyticsRange, Source } from "./types";

export interface AnalyticsContextValue {
  source: Source;
  range: AnalyticsRange;
  comparePrior: boolean;
  days?: number;
  /** Trend brush selection (ISO date strings). */
  brushStart?: string;
  brushEnd?: string;
  /**
   * R9 §5 — cross-filter: when set, charts that can focus a single question
   * type narrow to it (URL-encoded as `?type=`). Selecting a row in the
   * MasteryMatrix sets this; clearing it returns every chart to the full view.
   */
  typeFocus?: QType;
  /** Set/clear the cross-filter focus (no-op outside the provider). */
  setTypeFocus?: (q: QType | null) => void;
}

const AnalyticsContext = createContext<AnalyticsContextValue | null>(null);

export function AnalyticsProvider({
  value,
  children,
}: {
  value: AnalyticsContextValue;
  children: React.ReactNode;
}) {
  return (
    <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
  );
}

export function useAnalyticsContext(): AnalyticsContextValue {
  const ctx = useContext(AnalyticsContext);
  if (!ctx) {
    return { source: "all", range: "all", comparePrior: false };
  }
  return ctx;
}
