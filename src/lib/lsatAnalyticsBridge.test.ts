import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLsatActivity, getLsatCalibration } from './lsatAnalyticsBridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      for (const [frag, fn] of Object.entries(routes)) {
        if (url.includes(frag)) return Promise.resolve(fn());
      }
      return Promise.reject(new Error(`unrouted ${url}`));
    }) as unknown as typeof fetch,
  );
}

describe('getLsatActivity', () => {
  it('normalizes a per-day activity array from the sidecar', async () => {
    stubFetch({
      '/api/analytics/activity': () =>
        new Response(
          JSON.stringify([
            { date: '2026-06-10', questions: 8, minutes: 30, correct: 6, sessions: 1 },
            { date: '2026-06-11', questions: 3, minutes: 12, correct: 2, sessions: 1 },
          ]),
          { status: 200 },
        ),
    });
    const r = await getLsatActivity(120);
    expect(r.reachable).toBe(true);
    expect(r.days).toHaveLength(2);
    expect(r.days[0]).toEqual({ date: '2026-06-10', questions: 8, minutes: 30, correct: 6, sessions: 1 });
  });

  it('coerces missing/non-numeric fields to 0 and drops dateless rows', async () => {
    stubFetch({
      '/api/analytics/activity': () =>
        new Response(
          JSON.stringify([
            { date: '2026-06-10', questions: '7' /* bad */, correct: 4 },
            { questions: 5 } /* no date — dropped */,
          ]),
          { status: 200 },
        ),
    });
    const r = await getLsatActivity();
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toEqual({ date: '2026-06-10', questions: 0, minutes: 0, correct: 4, sessions: 0 });
  });

  it('degrades to reachable:false + empty days when the sidecar is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const r = await getLsatActivity();
    expect(r.reachable).toBe(false);
    expect(r.days).toEqual([]);
  });

  it('degrades on a non-2xx response (no throw)', async () => {
    stubFetch({ '/api/analytics/activity': () => new Response('boom', { status: 503 }) });
    const r = await getLsatActivity();
    expect(r.reachable).toBe(false);
    expect(r.days).toEqual([]);
  });

  it('degrades when the body is not an array', async () => {
    stubFetch({
      '/api/analytics/activity': () => new Response(JSON.stringify({ detail: 'nope' }), { status: 200 }),
    });
    const r = await getLsatActivity();
    expect(r.reachable).toBe(false);
    expect(r.days).toEqual([]);
  });
});

describe('getLsatCalibration', () => {
  it('normalizes per-band calibration + verdict from the sidecar', async () => {
    stubFetch({
      '/api/analytics/calibration': () =>
        new Response(
          JSON.stringify({
            bands: [
              { confidence: 'sure', attempts: 10, correct: 7, accuracy: 0.7, nominal_confidence: 0.9 },
              { confidence: 'guess', attempts: 4, correct: 3, accuracy: 0.75, nominal_confidence: 0.3 },
              { confidence: 'likely', attempts: 0, correct: 0, accuracy: null, nominal_confidence: 0.65 },
            ],
            verdict: 'overconfident',
            calibration_gap: 0.12,
          }),
          { status: 200 },
        ),
    });
    const r = await getLsatCalibration();
    expect(r.reachable).toBe(true);
    expect(r.bands).toHaveLength(3);
    expect(r.bands[0]).toEqual({ confidence: 'sure', attempts: 10, correct: 7, accuracy: 0.7, nominal_confidence: 0.9 });
    expect(r.bands[2].accuracy).toBeNull();
    expect(r.verdict).toBe('overconfident');
    expect(r.calibrationGap).toBe(0.12);
  });

  it('degrades to reachable:false + empty bands when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const r = await getLsatCalibration();
    expect(r.reachable).toBe(false);
    expect(r.bands).toEqual([]);
    expect(r.verdict).toBeNull();
    expect(r.calibrationGap).toBeNull();
  });

  it('degrades when the body is missing/invalid (array or non-object)', async () => {
    stubFetch({
      '/api/analytics/calibration': () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
    });
    const r = await getLsatCalibration();
    expect(r.reachable).toBe(false);
    expect(r.bands).toEqual([]);
  });

  it('passes a days window into the query string when provided', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(new Response(JSON.stringify({ bands: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await getLsatCalibration(30);
    expect(fetchMock.mock.calls[0][0]).toContain('days=30');
  });
});
