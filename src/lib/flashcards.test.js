import { describe, expect, it } from 'vitest';
import { buildFlashcards } from './flashcards';

describe('flashcard deck builder', () => {
  it('scopes Level III flashcards to the active pathway', async () => {
    const privateMarkets = await buildFlashcards([], { level3Pathway: 'private-markets' });
    const privateWealth = await buildFlashcards([], { level3Pathway: 'private-wealth' });

    expect(privateMarkets.some((card) => card.topic === 'level3:private-markets-pathway')).toBe(true);
    expect(privateMarkets.some((card) => card.topic === 'level3:private-wealth-pathway')).toBe(false);
    expect(privateWealth.some((card) => card.topic === 'level3:private-wealth-pathway')).toBe(true);
    expect(privateWealth.some((card) => card.topic === 'level3:private-markets-pathway')).toBe(false);
  });
});
