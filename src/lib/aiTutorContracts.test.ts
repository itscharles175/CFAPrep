import { describe, expect, it } from 'vitest';
import { createMockTutorProvider, createUnavailableTutorProvider } from './aiTutorContracts';

describe('AI tutor provider contracts', () => {
  it('keeps unavailable tutoring deterministic and blocked', async () => {
    const provider = createUnavailableTutorProvider();
    const response = await provider.explainMissedAnswer({ context: { domain: 'cfa', topic: 'ethics' } });

    expect(provider.metadata.enabled).toBe(false);
    expect(response.blockedReason).toContain('AI tutoring is not enabled');
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
    expect(response.sourceIds).toEqual(['fi-lo1']);
    expect(response.safetyFlags).toEqual([]);
  });
});
