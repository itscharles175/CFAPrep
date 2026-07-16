import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticsBundle,
  cloudBudgetUsedPct,
  CLOUD_BUDGET_WARN_PCT,
  detectModelOutage,
  diagnosticsFilename,
  evaluateGuardrails,
  formatCadence,
  INDEXEDDB_QUOTA_WARN_PCT,
  storageUsedPct,
} from './maintenancePanel';
import type { LsatCloudBudgetReport } from './lsatBackend';
import type { AggregatedSystemHealth } from './systemHealth';

function cloudReport(overrides: Partial<LsatCloudBudgetReport['cloud']> = {}): LsatCloudBudgetReport {
  return {
    ok: true,
    reachable: true,
    detail: 'ok',
    cloud: {
      spend_usd: 0,
      budget_usd: 10,
      within_budget: true,
      remaining_usd: 10,
      cloud_enabled: true,
      dry_run: false,
      pricing: { input_cost_per_mtok_usd: 1, output_cost_per_mtok_usd: 2 },
      next_call: { input_tokens: 100, output_tokens: 50, estimated_cost_usd: 0.001, would_exceed_budget: false },
      ...overrides,
    },
  };
}

function health(overrides: Partial<AggregatedSystemHealth> = {}): AggregatedSystemHealth {
  return {
    verdict: 'ok',
    sidecars: null,
    backend: null,
    ...overrides,
  };
}

describe('cloudBudgetUsedPct', () => {
  it('returns null when no budget is configured', () => {
    expect(cloudBudgetUsedPct(cloudReport({ budget_usd: null }))).toBeNull();
    expect(cloudBudgetUsedPct(cloudReport({ budget_usd: 0 }))).toBeNull();
    expect(cloudBudgetUsedPct(null)).toBeNull();
  });

  it('computes the percent of the budget spent', () => {
    expect(cloudBudgetUsedPct(cloudReport({ budget_usd: 10, spend_usd: 8 }))).toBeCloseTo(80);
    expect(cloudBudgetUsedPct(cloudReport({ budget_usd: 10, spend_usd: 12 }))).toBeCloseTo(120);
  });
});

describe('storageUsedPct', () => {
  it('returns null on missing / zero-quota estimates', () => {
    expect(storageUsedPct(null)).toBeNull();
    expect(storageUsedPct({ usage: 5 })).toBeNull();
    expect(storageUsedPct({ usage: 5, quota: 0 })).toBeNull();
  });

  it('computes usage percent', () => {
    expect(storageUsedPct({ usage: 90, quota: 100 })).toBeCloseTo(90);
  });
});

describe('detectModelOutage', () => {
  it('returns null on healthy / unknown health', () => {
    expect(detectModelOutage(null)).toBeNull();
    expect(detectModelOutage(health())).toBeNull();
  });

  it('detects ai_not_ready and *_unreachable and model_missing reasons', () => {
    expect(detectModelOutage(health({ backend: { reasons: ['ai_not_ready'] } as never }))).toBe('ai_not_ready');
    expect(detectModelOutage(health({ backend: { reasons: ['ollama_unreachable'] } as never }))).toBe(
      'ollama_unreachable',
    );
    expect(detectModelOutage(health({ backend: { reasons: ['model_missing:explain'] } as never }))).toBe(
      'model_missing:explain',
    );
  });

  it('treats a hard error verdict as an outage', () => {
    expect(detectModelOutage(health({ verdict: 'error' }))).toBe('service_down');
  });
});

describe('evaluateGuardrails', () => {
  it('returns no banners when everything is healthy and within budget', () => {
    expect(
      evaluateGuardrails({
        cloudBudget: cloudReport({ budget_usd: 10, spend_usd: 1 }),
        storageEstimate: { usage: 10, quota: 100 },
        aggregatedHealth: health(),
      }),
    ).toEqual([]);
  });

  it('fires the cloud-budget banner at the warn threshold (warning), and danger when over', () => {
    const warn = evaluateGuardrails({
      cloudBudget: cloudReport({ budget_usd: 100, spend_usd: CLOUD_BUDGET_WARN_PCT }),
    });
    const cloud = warn.find((b) => b.id === 'cloud-budget');
    expect(cloud?.tone).toBe('warning');

    const over = evaluateGuardrails({ cloudBudget: cloudReport({ budget_usd: 100, spend_usd: 120 }) });
    expect(over.find((b) => b.id === 'cloud-budget')?.tone).toBe('danger');
  });

  it('fires the IndexedDB-quota banner at the warn threshold', () => {
    const banners = evaluateGuardrails({
      storageEstimate: { usage: INDEXEDDB_QUOTA_WARN_PCT, quota: 100 },
    });
    expect(banners.find((b) => b.id === 'indexeddb-quota')?.tone).toBe('warning');

    const danger = evaluateGuardrails({ storageEstimate: { usage: 96, quota: 100 } });
    expect(danger.find((b) => b.id === 'indexeddb-quota')?.tone).toBe('danger');
  });

  it('lists the model-outage banner first (danger)', () => {
    const banners = evaluateGuardrails({
      aggregatedHealth: health({ backend: { reasons: ['ai_not_ready'] } as never }),
      cloudBudget: cloudReport({ budget_usd: 100, spend_usd: 90 }),
    });
    expect(banners[0].id).toBe('model-outage');
    expect(banners[0].tone).toBe('danger');
    expect(banners.map((b) => b.id)).toContain('cloud-budget');
  });

  it('respects threshold overrides', () => {
    // A 60% spend should NOT fire at the default 80% threshold...
    expect(
      evaluateGuardrails({ cloudBudget: cloudReport({ budget_usd: 100, spend_usd: 60 }) }).some(
        (b) => b.id === 'cloud-budget',
      ),
    ).toBe(false);
    // ...but DOES with a lowered override.
    expect(
      evaluateGuardrails({
        cloudBudget: cloudReport({ budget_usd: 100, spend_usd: 60 }),
        cloudBudgetWarnPct: 50,
      }).some((b) => b.id === 'cloud-budget'),
    ).toBe(true);
  });
});

describe('buildDiagnosticsBundle', () => {
  it('produces a well-formed bundle with empty defaults', () => {
    const now = new Date('2026-06-16T14:30:05.123Z');
    const bundle = buildDiagnosticsBundle({ now, env: { userAgent: 'test', isElectron: false, href: 'app://x' } });
    expect(bundle.schema).toBe('studyvault.diagnostics.v2');
    expect(bundle.generated_at).toBe('2026-06-16T14:30:05.123Z');
    expect(bundle.app).toEqual({ user_agent: 'test', is_electron: false, href: 'app://x' });
    expect(bundle.trust_manifest).toBeNull();
    expect(bundle.runtime_evidence).toEqual([]);
    expect(bundle.sidecars).toEqual({ status: null, logs: {} });
    expect(bundle.maintenance).toEqual({ scheduled_tasks: [], recent_runs: [] });
    expect(bundle.guardrails).toEqual([]);
  });

  it('threads through provided inputs and copies arrays (no mutation)', () => {
    const runtime = [{ t: 1, cloudSpendUsd: 1, llmP50Ms: 2, genQueueDepth: 0, sqliteBusyRetries: 0 }];
    const bundle = buildDiagnosticsBundle({
      now: new Date('2026-06-16T00:00:00.000Z'),
      env: { userAgent: null, isElectron: true, href: null },
      runtimeEvidence: runtime,
      cloudMetrics: cloudReport(),
      sidecarLogs: { 'LSAT backend': ['line a'] },
    });
    expect(bundle.app.is_electron).toBe(true);
    expect(bundle.runtime_evidence).toEqual(runtime);
    expect(bundle.runtime_evidence).not.toBe(runtime); // copied, not the same ref
    expect(bundle.cloud_metrics?.cloud?.budget_usd).toBe(10);
    expect(bundle.sidecars.logs['LSAT backend']).toEqual(['line a']);
  });
});

describe('diagnosticsFilename', () => {
  it('produces a Windows-safe timestamped filename (no colons)', () => {
    const name = diagnosticsFilename(new Date('2026-06-16T14:30:05.000Z'));
    expect(name).toMatch(/^studyvault-diagnostics-2026-06-16T14-30-05Z\.json$/);
    expect(name).not.toContain(':');
  });
});

describe('formatCadence', () => {
  it('formats common cadences with whole units', () => {
    expect(formatCadence(3600)).toBe('1h');
    expect(formatCadence(86400)).toBe('1d');
    expect(formatCadence(6 * 3600)).toBe('6h');
    expect(formatCadence(7 * 86400)).toBe('7d');
    expect(formatCadence(90)).toBe('90s');
  });

  it('handles invalid input', () => {
    expect(formatCadence(0)).toBe('—');
    expect(formatCadence(-5)).toBe('—');
  });
});
