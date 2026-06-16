import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeMetrics,
  getRuntimeMetrics,
  latestMetric,
  metricSeries,
  recordRuntimeSample,
  RUNTIME_HISTORY_CAPACITY,
  subscribeRuntimeMetrics,
} from './runtimeMetricsStore';
import type { BackendHealthAggregate } from './systemHealth';

function backend(overrides: Partial<BackendHealthAggregate> = {}): BackendHealthAggregate {
  return {
    status: 'ok',
    ok: true,
    reasons: [],
    db_ready: true,
    worker_ready: true,
    backup_status: 'fresh',
    gen_queued: 0,
    gen_running: 0,
    explain_p50_ms: 120,
    cloud_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    cloud_monthly_budget_usd: 5,
    cloud_spend_mtd_usd: 0.25,
    cloud_budget_within: true,
    sqlite_health: { pragmas: { journal_mode: 'wal' }, busy_retries: 3, wal_estimate_if_cheap: 4096 },
    ...overrides,
  };
}

afterEach(() => {
  clearRuntimeMetrics();
});

describe('runtimeMetricsStore', () => {
  it('records a backend report into the series and exposes the latest value', () => {
    recordRuntimeSample(backend({ explain_p50_ms: 200, cloud_spend_mtd_usd: 1.5 }), 1000);
    const samples = getRuntimeMetrics();
    expect(samples).toHaveLength(1);
    expect(samples[0].t).toBe(1000);
    expect(samples[0].llmP50Ms).toBe(200);
    expect(samples[0].cloudSpendUsd).toBe(1.5);
    expect(latestMetric('llmP50Ms')).toBe(200);
  });

  it('derives gen queue depth from queued + running', () => {
    recordRuntimeSample(backend({ gen_queued: 2, gen_running: 1 }), 1000);
    expect(latestMetric('genQueueDepth')).toBe(3);
  });

  it('records a null-filled gap sample when the backend is unreachable', () => {
    recordRuntimeSample(null, 2000);
    const [sample] = getRuntimeMetrics();
    expect(sample.t).toBe(2000);
    expect(sample.cloudSpendUsd).toBeNull();
    expect(sample.llmP50Ms).toBeNull();
    expect(sample.genQueueDepth).toBeNull();
    expect(sample.sqliteBusyRetries).toBeNull();
  });

  it('metricSeries drops gaps and keeps only finite points in order', () => {
    recordRuntimeSample(backend({ explain_p50_ms: 100 }), 1);
    recordRuntimeSample(null, 2);
    recordRuntimeSample(backend({ explain_p50_ms: 150 }), 3);
    expect(metricSeries('llmP50Ms')).toEqual([100, 150]);
  });

  it('caps the ring buffer at the configured capacity (evicting oldest)', () => {
    for (let i = 0; i < RUNTIME_HISTORY_CAPACITY + 25; i += 1) {
      recordRuntimeSample(backend({ cloud_spend_mtd_usd: i }), i);
    }
    const samples = getRuntimeMetrics();
    expect(samples).toHaveLength(RUNTIME_HISTORY_CAPACITY);
    // Oldest evicted: first retained sample is index 25.
    expect(samples[0].cloudSpendUsd).toBe(25);
    expect(samples[samples.length - 1].cloudSpendUsd).toBe(RUNTIME_HISTORY_CAPACITY + 24);
  });

  it('notifies subscribers on record and clear, and pushes the current snapshot on subscribe', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeRuntimeMetrics((samples) => seen.push(samples.length));
    expect(seen).toEqual([0]); // immediate push of empty snapshot
    recordRuntimeSample(backend(), 1);
    expect(seen).toEqual([0, 1]);
    clearRuntimeMetrics();
    expect(seen).toEqual([0, 1, 0]);
    unsubscribe();
    recordRuntimeSample(backend(), 2);
    expect(seen).toEqual([0, 1, 0]); // no further notifications after unsubscribe
  });

  it('treats a non-finite metric as a gap rather than recording NaN', () => {
    recordRuntimeSample(backend({ explain_p50_ms: Number.NaN as unknown as number }), 1);
    expect(latestMetric('llmP50Ms')).toBeNull();
  });
});
