import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gradeConstructedResponseStructured } from './localLlm';

function jsonResponse(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  });
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SAMPLE_RUBRIC = [
  { id: 'c1', label: 'Identifies the IPS objective', maxPoints: 4 },
  { id: 'c2', label: 'Computes required return correctly', maxPoints: 6 },
  { id: 'c3', label: 'Cites appropriate constraints', maxPoints: 4 },
];

describe('gradeConstructedResponseStructured', () => {
  it('parses a complete JSON grade and synthesises overall PASS', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                criteria: [
                  { id: 'c1', verdict: 'Met', score: 4, evidence: 'Names the IPS goal.', improvement: 'Could be sharper.' },
                  { id: 'c2', verdict: 'Met', score: 5, evidence: 'Math is correct.', improvement: 'Add a step.' },
                  { id: 'c3', verdict: 'Partial', score: 3, evidence: 'Lists two of three.', improvement: 'Add liquidity constraint.' },
                ],
                summary: 'Strong overall, minor gap on constraints.',
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const grade = await gradeConstructedResponseStructured({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      prompt: 'Write an IPS for the Bardells',
      response: 'IPS goal is capital preservation with 5% real return…',
      rubric: SAMPLE_RUBRIC,
    });

    expect(grade.criteria).toHaveLength(3);
    expect(grade.overall.total).toBe(12);
    expect(grade.overall.max).toBe(14);
    expect(grade.overall.percent).toBe(86);
    expect(grade.overall.verdict).toBe('PASS');
    expect(grade.overall.summary).toContain('Strong');
  });

  it('caps score at maxPoints if the model over-awards', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          criteria: [
            { id: 'c1', verdict: 'Met', score: 99, evidence: 'X', improvement: 'Y' },
            { id: 'c2', verdict: 'Met', score: 6, evidence: 'X', improvement: 'Y' },
            { id: 'c3', verdict: 'Met', score: 4, evidence: 'X', improvement: 'Y' },
          ],
        }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const grade = await gradeConstructedResponseStructured({
      settings: {},
      prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
    });
    expect(grade.criteria[0].score).toBe(4);
    expect(grade.overall.total).toBe(14);
  });

  it('classifies BORDERLINE between 50% and 70%', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          criteria: [
            { id: 'c1', verdict: 'Partial', score: 2, evidence: 'X', improvement: 'Y' },
            { id: 'c2', verdict: 'Partial', score: 4, evidence: 'X', improvement: 'Y' },
            { id: 'c3', verdict: 'Partial', score: 2, evidence: 'X', improvement: 'Y' },
          ],
        }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const grade = await gradeConstructedResponseStructured({
      settings: {}, prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
    });
    // 2+4+2 / 14 = 57%
    expect(grade.overall.percent).toBe(57);
    expect(grade.overall.verdict).toBe('BORDERLINE');
  });

  it('classifies FAIL below 50%', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          criteria: [
            { id: 'c1', verdict: 'Missed', score: 0, evidence: 'X', improvement: 'Y' },
            { id: 'c2', verdict: 'Partial', score: 2, evidence: 'X', improvement: 'Y' },
            { id: 'c3', verdict: 'Missed', score: 0, evidence: 'X', improvement: 'Y' },
          ],
        }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const grade = await gradeConstructedResponseStructured({
      settings: {}, prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
    });
    expect(grade.overall.verdict).toBe('FAIL');
  });

  it('fills in skipped criteria as Missed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          criteria: [
            { id: 'c1', verdict: 'Met', score: 4, evidence: 'X', improvement: 'Y' },
            // c2 + c3 omitted
          ],
        }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const grade = await gradeConstructedResponseStructured({
      settings: {}, prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
    });
    expect(grade.criteria).toHaveLength(3);
    expect(grade.criteria.find((c) => c.id === 'c2').verdict).toBe('Missed');
    expect(grade.criteria.find((c) => c.id === 'c3').verdict).toBe('Missed');
  });

  it('rejects an empty rubric', async () => {
    await expect(
      gradeConstructedResponseStructured({
        settings: {}, prompt: 'p', response: 'r', rubric: [],
      }),
    ).rejects.toThrow(/No rubric criteria/i);
  });

  it('throws when the model returns no JSON object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'I cannot grade this.' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      gradeConstructedResponseStructured({
        settings: {}, prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
      }),
    ).rejects.toThrow(/JSON/i);
  });

  it('ignores criteria with ids not in the rubric', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          criteria: [
            { id: 'c1', verdict: 'Met', score: 4, evidence: 'X', improvement: 'Y' },
            { id: 'made_up', verdict: 'Met', score: 100, evidence: 'X', improvement: 'Y' },
            { id: 'c2', verdict: 'Met', score: 6, evidence: 'X', improvement: 'Y' },
            { id: 'c3', verdict: 'Met', score: 4, evidence: 'X', improvement: 'Y' },
          ],
        }) } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const grade = await gradeConstructedResponseStructured({
      settings: {}, prompt: 'p', response: 'r', rubric: SAMPLE_RUBRIC,
    });
    expect(grade.criteria).toHaveLength(3);
    expect(grade.criteria.find((c) => c.id === 'made_up')).toBeUndefined();
  });
});
