import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * ANL-5 — unified analytics filter context.
 *
 * One persisted shape for the cross-domain analytics filters (date range,
 * source/domain, prior-period compare) so the host Analytics page — and any
 * future shared analytics surface — reads/writes the same selection. The
 * vocabulary mirrors the LSAT domain's analytics filters (range / source /
 * comparePrior) so the two analytics experiences converge.
 *
 * Persistence is plain `localStorage` (local-only personal app, no sync). Reads
 * are defensive: a malformed/absent entry falls back to the defaults, and any
 * storage error (private mode, quota, SSR) degrades to in-memory state.
 */

/** Trailing-window presets. `all` = no window. */
export type AnalyticsRange = '7d' | '30d' | '90d' | 'all';

/** Domain/source filter, parallel to the host Analytics domain toggle. */
export type AnalyticsSource = 'all' | 'cfa' | 'lsat';

export interface AnalyticsFilterState {
  range: AnalyticsRange;
  source: AnalyticsSource;
  /** Overlay the prior equivalent window for comparison. */
  comparePrior: boolean;
}

export interface AnalyticsFilterContextValue extends AnalyticsFilterState {
  setRange: (range: AnalyticsRange) => void;
  setSource: (source: AnalyticsSource) => void;
  setComparePrior: (comparePrior: boolean) => void;
  /** Patch any subset of the filters at once. */
  setFilters: (patch: Partial<AnalyticsFilterState>) => void;
  reset: () => void;
}

export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilterState = {
  range: '30d',
  source: 'all',
  comparePrior: false,
};

const STORAGE_KEY = 'studyvault:analytics-filters:v1';

const VALID_RANGES: readonly AnalyticsRange[] = ['7d', '30d', '90d', 'all'];
const VALID_SOURCES: readonly AnalyticsSource[] = ['all', 'cfa', 'lsat'];

/** Number of days in a range window, or `null` for "all". Handy for callers
 *  that turn the selection into a date cutoff. */
export function rangeToDays(range: AnalyticsRange): number | null {
  switch (range) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'all':
    default:
      return null;
  }
}

/** Coerce an unknown parsed value into a valid filter state, dropping junk. */
function coerce(raw: unknown): AnalyticsFilterState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ANALYTICS_FILTERS };
  const obj = raw as Record<string, unknown>;
  const range = VALID_RANGES.includes(obj.range as AnalyticsRange)
    ? (obj.range as AnalyticsRange)
    : DEFAULT_ANALYTICS_FILTERS.range;
  const source = VALID_SOURCES.includes(obj.source as AnalyticsSource)
    ? (obj.source as AnalyticsSource)
    : DEFAULT_ANALYTICS_FILTERS.source;
  const comparePrior =
    typeof obj.comparePrior === 'boolean' ? obj.comparePrior : DEFAULT_ANALYTICS_FILTERS.comparePrior;
  return { range, source, comparePrior };
}

/** Read the persisted filters (defensive). */
export function readAnalyticsFilters(): AnalyticsFilterState {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_ANALYTICS_FILTERS };
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_ANALYTICS_FILTERS };
    return coerce(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_ANALYTICS_FILTERS };
  }
}

/** Persist the filters (best-effort; swallows storage errors). */
export function writeAnalyticsFilters(state: AnalyticsFilterState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode / quota / SSR — keep working in-memory.
  }
}

/**
 * Stateful hook backing the provider (also usable standalone). Hydrates from
 * localStorage on mount and writes through on every change.
 */
export function useAnalyticsFilterState(
  initial?: Partial<AnalyticsFilterState>,
): AnalyticsFilterContextValue {
  const [state, setState] = useState<AnalyticsFilterState>(() => ({
    ...readAnalyticsFilters(),
    ...initial,
  }));

  useEffect(() => {
    writeAnalyticsFilters(state);
  }, [state]);

  const setFilters = useCallback((patch: Partial<AnalyticsFilterState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);
  const setRange = useCallback((range: AnalyticsRange) => setFilters({ range }), [setFilters]);
  const setSource = useCallback((source: AnalyticsSource) => setFilters({ source }), [setFilters]);
  const setComparePrior = useCallback(
    (comparePrior: boolean) => setFilters({ comparePrior }),
    [setFilters],
  );
  const reset = useCallback(() => setState({ ...DEFAULT_ANALYTICS_FILTERS }), []);

  return useMemo(
    () => ({ ...state, setRange, setSource, setComparePrior, setFilters, reset }),
    [state, setRange, setSource, setComparePrior, setFilters, reset],
  );
}

const AnalyticsFilterContext = createContext<AnalyticsFilterContextValue | null>(null);

/**
 * Provider — wrap an analytics surface to share the persisted filter selection.
 * Uses `createElement` (no JSX) so this stays a plain `.ts` module.
 */
export function AnalyticsFilterProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Partial<AnalyticsFilterState>;
}) {
  const value = useAnalyticsFilterState(initial);
  return createElement(AnalyticsFilterContext.Provider, { value }, children);
}

/**
 * Consume the filters. Outside a provider this returns a read-only snapshot of
 * the persisted defaults with no-op setters, so unwrapped call sites never
 * crash (parallel to the LSAT analytics context's defaulting behaviour).
 */
export function useAnalyticsFilters(): AnalyticsFilterContextValue {
  const ctx = useContext(AnalyticsFilterContext);
  if (ctx) return ctx;
  const snapshot = readAnalyticsFilters();
  const noop = () => undefined;
  return {
    ...snapshot,
    setRange: noop,
    setSource: noop,
    setComparePrior: noop,
    setFilters: noop,
    reset: noop,
  };
}
