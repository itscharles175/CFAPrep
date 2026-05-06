import { describe, expect, it } from 'vitest';
import { createMockTutorProvider, createUnavailableTutorProvider, evaluateTutorResponse } from './aiTutorContracts';

describe('AI tutor provider contracts', () => {
  it('keeps unavailable tutoring deterministic and blocked', async () => {
    const provider = createUnavailableTutorProvider();
    const response = await provider.explainMissedAnswer({ context: { domain: 'cfa', topic: 'ethics' } });

    expect(provider.metadata.enabled).toBe(false);
    expect(provider.metadata.capabilities).toEqual([]);
    expect(response.blockedReason).toContain('AI tutoring is not enabled');
    expect((await provider.provideGroundedHint({ context: { domain: 'cfa', topic: 'ethics' } })).blockedReason).toContain('AI tutoring is not enabled');
    expect((await provider.suggestNextPractice({ context: { domain: 'cfa', topic: 'ethics' }, count: 2 })).blockedReason).toContain('AI tutoring is not enabled');
    expect(await provider.generateExtraPractice({ context: { domain: 'cfa', topic: 'ethics' }, count: 3 })).toEqual([]);
  });

  it('exposes a grounded mock provider for UI and eval development', async () => {
    const provider = createMockTutorProvider();
    const response = await provider.summarizeWeakTopic({
      domain: 'cfa',
      topic: 'fixed-income',
      sourceIds: ['fi-lo1'],
    });

    expect(provider.metadata.capabilities).toContain('weak-topic-summary');
    expect(provider.metadata.capabilities).toContain('grounded-hint');
    expect(provider.metadata.capabilities).toContain('next-practice-suggestion');
    expect(response.sourceIds).toEqual(['fi-lo1']);
    expect(response.safetyFlags).toEqual([]);

    const hint = await provider.provideGroundedHint({
      context: { domain: 'cfa', topic: 'fixed-income', sourceIds: ['fi-question-1'] },
    });
    const nextPractice = await provider.suggestNextPractice({
      context: { domain: 'cfa', topic: 'fixed-income', sourceIds: ['fi-lo1'] },
      count: 3,
      difficulty: 'intermediate',
    });

    expect(hint.sourceIds).toEqual(['fi-question-1']);
    expect(nextPractice.text).toContain('3 intermediate');
    expect(nextPractice.sourceIds).toEqual(['fi-lo1']);
    expect(
      evaluateTutorResponse(
        { id: 'weak-topic-summary-fi', capability: 'weak-topic-summary', requiredSourceIds: ['fi-lo1'] },
        response,
      ),
    ).toMatchObject({ passed: true, issues: [] });
    expect(
      evaluateTutorResponse(
        { id: 'missing-source', capability: 'grounded-hint', requiredSourceIds: ['missing-source'] },
        hint,
      ).issues[0],
    ).toContain('Missing required sourceId');
  });
});
