/**
 * UC6 — Core Web Vitals collection, LOCAL-ONLY.
 *
 * StudyVault is an offline desktop app with no remote analytics, so this module
 * collects the three render-quality vitals — LCP (Largest Contentful Paint),
 * CLS (Cumulative Layout Shift), and INP (Interaction to Next Paint) — using the
 * browser-native `PerformanceObserver` API. There is NO npm `web-vitals`
 * dependency and nothing is ever sent anywhere: values live in a process-local
 * store, are read by the System Health page, and vanish on reload.
 *
 * Each metric follows Google's standard collection semantics closely enough for
 * a self-diagnostic readout:
 *  - LCP: the largest contentful paint reported before the first interaction or
 *    page hide (we keep the latest `largest-contentful-paint` entry).
 *  - CLS: the maximum session-window sum of `layout-shift` entries that were not
 *    preceded by recent user input (1s gap / 5s window grouping).
 *  - INP: the worst (here: the highest) interaction latency seen, derived from
 *    `event` entries with a non-zero `interactionId` (plus the first-input).
 *
 * The good / needs-improvement / poor thresholds are the published Core Web
 * Vitals boundaries (https://web.dev/articles/vitals).
 */

import { useEffect, useState } from 'react';

export type WebVitalName = 'LCP' | 'CLS' | 'INP';

export type WebVitalRating = 'good' | 'needs-improvement' | 'poor' | 'pending';

export interface WebVitalMetric {
  /** Metric short name. */
  name: WebVitalName;
  /** Latest value (ms for LCP/INP, unitless ratio for CLS), or null until seen. */
  value: number | null;
  /** Bucket of `value` against the published Core Web Vitals thresholds. */
  rating: WebVitalRating;
}

export interface WebVitalsSnapshot {
  LCP: WebVitalMetric;
  CLS: WebVitalMetric;
  INP: WebVitalMetric;
  /** Whether the PerformanceObserver-based collector is running in this env. */
  supported: boolean;
}

// Published Core Web Vitals thresholds. value <= good → "good";
// value <= needsImprovement → "needs-improvement"; otherwise "poor".
const THRESHOLDS: Record<WebVitalName, { good: number; needsImprovement: number; unit: 'ms' | '' }> = {
  LCP: { good: 2500, needsImprovement: 4000, unit: 'ms' },
  CLS: { good: 0.1, needsImprovement: 0.25, unit: '' },
  INP: { good: 200, needsImprovement: 500, unit: 'ms' },
};

/** Rate a raw metric value against the published thresholds. */
export function rateWebVital(name: WebVitalName, value: number | null): WebVitalRating {
  if (value == null || !Number.isFinite(value)) return 'pending';
  const { good, needsImprovement } = THRESHOLDS[name];
  if (value <= good) return 'good';
  if (value <= needsImprovement) return 'needs-improvement';
  return 'poor';
}

/** Threshold metadata for a metric (for tooltips / unit-aware formatting). */
export function getWebVitalThresholds(name: WebVitalName): { good: number; needsImprovement: number; unit: 'ms' | '' } {
  return THRESHOLDS[name];
}

/** Format a value for display: integer ms for LCP/INP, 3-decimal ratio for CLS. */
export function formatWebVital(name: WebVitalName, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (name === 'CLS') return value.toFixed(3);
  return `${Math.round(value)} ms`;
}

// ---------------------------------------------------------------------------
// Process-local store
// ---------------------------------------------------------------------------

type Listener = (snapshot: WebVitalsSnapshot) => void;

const rawValues: Record<WebVitalName, number | null> = { LCP: null, CLS: null, INP: null };
const listeners = new Set<Listener>();
let started = false;
let supported = false;
const observers: PerformanceObserver[] = [];

function snapshot(): WebVitalsSnapshot {
  return {
    LCP: { name: 'LCP', value: rawValues.LCP, rating: rateWebVital('LCP', rawValues.LCP) },
    CLS: { name: 'CLS', value: rawValues.CLS, rating: rateWebVital('CLS', rawValues.CLS) },
    INP: { name: 'INP', value: rawValues.INP, rating: rateWebVital('INP', rawValues.INP) },
    supported,
  };
}

function emit(): void {
  const next = snapshot();
  for (const listener of listeners) listener(next);
}

function setValue(name: WebVitalName, value: number): void {
  rawValues[name] = value;
  emit();
}

/** Read the current values without subscribing. */
export function getWebVitals(): WebVitalsSnapshot {
  return snapshot();
}

/**
 * Subscribe to value changes. Returns an unsubscribe function. Calling this
 * lazily starts the collector (idempotent), so importing the module has no
 * side effects until something actually wants the data.
 */
export function subscribeWebVitals(listener: Listener): () => void {
  startWebVitals();
  listeners.add(listener);
  // Push the current snapshot immediately so late subscribers aren't blank.
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// PerformanceObserver wiring
// ---------------------------------------------------------------------------

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface PerformanceEventTimingLike extends PerformanceEntry {
  interactionId?: number;
}

function observe(type: string, buffered: boolean, callback: (entries: PerformanceEntry[]) => void): void {
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    // `durationThreshold` only applies to the "event" type; passing it for the
    // others is harmless (ignored by the UA).
    observer.observe({ type, buffered } as PerformanceObserverInit);
    observers.push(observer);
  } catch {
    // Unsupported entry type in this browser — skip silently; the metric just
    // stays "pending" rather than throwing.
  }
}

/**
 * Start observing Core Web Vitals. Idempotent and SSR/jsdom-safe — when the
 * PerformanceObserver API is unavailable it no-ops and leaves `supported`
 * false. Safe to call from a React effect.
 */
export function startWebVitals(): void {
  if (started) return;
  started = true;

  if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') {
    supported = false;
    return;
  }
  supported = true;

  // LCP — keep the latest reported entry's startTime.
  observe('largest-contentful-paint', true, (entries) => {
    const last = entries[entries.length - 1];
    if (last) setValue('LCP', last.startTime);
  });

  // CLS — session-window grouping (1s gap, 5s cap), keep the max window sum.
  let clsValue = 0;
  let sessionValue = 0;
  let sessionFirst = 0;
  let sessionLast = 0;
  observe('layout-shift', true, (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (entry.hadRecentInput) continue;
      if (
        sessionValue &&
        (entry.startTime - sessionLast >= 1000 || entry.startTime - sessionFirst >= 5000)
      ) {
        sessionValue = 0;
      }
      if (sessionValue === 0) sessionFirst = entry.startTime;
      sessionLast = entry.startTime;
      sessionValue += entry.value;
      if (sessionValue > clsValue) {
        clsValue = sessionValue;
        setValue('CLS', clsValue);
      }
    }
  });

  // INP — worst interaction latency from event-timing entries with a real
  // interactionId, plus the first-input entry.
  let worstInteraction = 0;
  const recordInteraction = (entries: PerformanceEntry[]) => {
    for (const entry of entries as PerformanceEventTimingLike[]) {
      const isInteraction = entry.entryType === 'first-input' || (entry.interactionId ?? 0) > 0;
      if (!isInteraction) continue;
      if (entry.duration > worstInteraction) {
        worstInteraction = entry.duration;
        setValue('INP', worstInteraction);
      }
    }
  };
  observe('event', true, recordInteraction);
  observe('first-input', true, recordInteraction);
}

/** Tear down all observers (used by tests and on full teardown). */
export function stopWebVitals(): void {
  for (const observer of observers) {
    try {
      observer.disconnect();
    } catch {
      // already disconnected — ignore
    }
  }
  observers.length = 0;
  started = false;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe a component to the latest Core Web Vitals snapshot. The collector
 * keeps running between mounts (it's process-local), so re-mounting a panel that
 * uses this hook resumes with whatever values were already observed.
 */
export function useWebVitals(): WebVitalsSnapshot {
  const [vitals, setVitals] = useState<WebVitalsSnapshot>(() => getWebVitals());
  useEffect(() => subscribeWebVitals(setVitals), []);
  return vitals;
}
