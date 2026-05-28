import { describe, expect, it } from 'vitest';
import l2Bank from './cfa-l2-los-bank.mjs';
import l3Bank from './cfa-l3-los-bank.mjs';
import { level2TopicSpecs } from '../src/domains/cfa/level2Packs/topics.ts';
import { level3TopicSpecs } from '../src/domains/cfa/level3Packs/topics.ts';
import {
  parseArgs,
  losLocator,
  buildEntryFromLosTopic,
  generateQuestionsFromLos,
  generateFlashcardsFromLos,
} from './content-expand.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

describe('LOS banks are well-formed', () => {
  it('L2 entries have topic, title, and 6–12 LOS each', () => {
    expect(Array.isArray(l2Bank)).toBe(true);
    expect(l2Bank.length).toBeGreaterThanOrEqual(10);
    for (const entry of l2Bank) {
      expect(isNonEmptyString(entry.topic)).toBe(true);
      expect(isNonEmptyString(entry.title)).toBe(true);
      expect(Array.isArray(entry.learningOutcomes)).toBe(true);
      expect(entry.learningOutcomes.length).toBeGreaterThanOrEqual(6);
      expect(entry.learningOutcomes.length).toBeLessThanOrEqual(12);
      for (const los of entry.learningOutcomes) {
        expect(isNonEmptyString(los)).toBe(true);
        expect(los.length).toBeGreaterThan(15);
      }
    }
  });

  it('L3 entries have topic, title, and 6–12 LOS each', () => {
    expect(Array.isArray(l3Bank)).toBe(true);
    expect(l3Bank.length).toBeGreaterThanOrEqual(8);
    for (const entry of l3Bank) {
      expect(isNonEmptyString(entry.topic)).toBe(true);
      expect(isNonEmptyString(entry.title)).toBe(true);
      expect(Array.isArray(entry.learningOutcomes)).toBe(true);
      expect(entry.learningOutcomes.length).toBeGreaterThanOrEqual(6);
      expect(entry.learningOutcomes.length).toBeLessThanOrEqual(12);
      for (const los of entry.learningOutcomes) {
        expect(isNonEmptyString(los)).toBe(true);
        expect(los.length).toBeGreaterThan(15);
      }
    }
  });

  it('L2 LOS bank covers exactly the topics in the in-app L2 registry', () => {
    const bankTopics = new Set(l2Bank.map((entry) => entry.topic));
    const registryTopics = new Set(level2TopicSpecs.map((spec) => spec.id));
    expect([...bankTopics].sort()).toEqual([...registryTopics].sort());
    // Titles align too.
    for (const entry of l2Bank) {
      const spec = level2TopicSpecs.find((s) => s.id === entry.topic);
      expect(spec).toBeDefined();
      expect(entry.title).toBe(spec.title);
    }
  });

  it('L3 LOS bank covers exactly the topics in the in-app L3 registry', () => {
    const bankTopics = new Set(l3Bank.map((entry) => entry.topic));
    const registryTopics = new Set(level3TopicSpecs.map((spec) => spec.id));
    expect([...bankTopics].sort()).toEqual([...registryTopics].sort());
    for (const entry of l3Bank) {
      const spec = level3TopicSpecs.find((s) => s.id === entry.topic);
      expect(spec).toBeDefined();
      expect(entry.title).toBe(spec.title);
    }
  });
});

describe('losLocator', () => {
  it('uses the first six words of the LOS', () => {
    expect(losLocator('Calculate the no-arbitrage price of a forward contract on a stock')).toBe(
      'LOS: Calculate the no-arbitrage price of a',
    );
  });

  it('handles short LOS without truncating', () => {
    expect(losLocator('Describe duration')).toBe('LOS: Describe duration');
  });

  it('returns LOS placeholder for empty input', () => {
    expect(losLocator('')).toBe('LOS');
    expect(losLocator(undefined)).toBe('LOS');
  });
});

describe('parseArgs --from-los', () => {
  it('accepts level2 and level3', () => {
    expect(parseArgs(['--from-los', 'level2']).fromLos).toBe('level2');
    expect(parseArgs(['--from-los', 'level3']).fromLos).toBe('level3');
  });

  it('rejects anything else', () => {
    expect(() => parseArgs(['--from-los', 'level1'])).toThrow(/level2 or level3/);
    expect(() => parseArgs(['--from-los', 'foo'])).toThrow(/level2 or level3/);
  });
});

describe('generateQuestionsFromLos with fake generate', () => {
  it('returns parsed questions keyed by the LOS locator', async () => {
    const fakeGenerate = async ({ user }) => {
      expect(user).toContain('LOS: Calculate the no-arbitrage price of a forward contract');
      return JSON.stringify([
        {
          question: 'What is the no-arbitrage price of a forward?',
          options: ['Spot * (1+r)^T', 'Spot - dividend', 'Random'],
          correct: 0,
          explanation: 'Carry-arbitrage model.',
        },
      ]);
    };
    const out = await generateQuestionsFromLos({
      baseUrl: 'http://localhost:1234/v1',
      model: 'fake',
      temperature: 0,
      level: 'level2',
      topicTitle: 'Derivatives',
      los: 'Calculate the no-arbitrage price of a forward contract',
      count: 1,
      generate: fakeGenerate,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ai-1');
    expect(out[0].locator).toBe('LOS: Calculate the no-arbitrage price of a');
    expect(out[0].correct).toBe(0);
  });
});

describe('generateFlashcardsFromLos with fake generate', () => {
  it('normalizes Front/Back casing and attaches the LOS locator', async () => {
    const fakeGenerate = async () =>
      JSON.stringify([
        { Front: 'What is the carry-arbitrage model?', Back: 'Forward = Spot * (1+r)^T.' },
        { front: 'Define delta', back: 'Sensitivity to underlying.' },
      ]);
    const out = await generateFlashcardsFromLos({
      baseUrl: 'http://localhost:1234/v1',
      model: 'fake',
      temperature: 0,
      level: 'level3',
      topicTitle: 'Derivatives And Risk Management',
      los: 'Describe and evaluate the use of futures, options, and swaps',
      count: 2,
      generate: fakeGenerate,
    });
    expect(out).toHaveLength(2);
    expect(out[0].locator).toBe('LOS: Describe and evaluate the use of');
    expect(out[0].id).toBe('flash-1');
    expect(out[1].id).toBe('flash-2');
  });
});

describe('buildEntryFromLosTopic dispatch', () => {
  it('keys results under the right level and topic when the fake generator succeeds', async () => {
    let questionCalls = 0;
    let flashCalls = 0;
    const fakeGenerate = async ({ system }) => {
      if (system.includes('exam writer')) {
        questionCalls += 1;
        return JSON.stringify([
          {
            question: `Q${questionCalls}`,
            options: ['a', 'b', 'c'],
            correct: 1,
            explanation: 'Because.',
          },
        ]);
      }
      flashCalls += 1;
      return JSON.stringify([
        { front: `F${flashCalls}`, back: `B${flashCalls}` },
      ]);
    };
    const entry = l2Bank.find((e) => e.topic === 'derivatives');
    const built = await buildEntryFromLosTopic({
      topicEntry: entry,
      level: 'level2',
      questionsPerLos: 1,
      flashcardsPerLos: 1,
      maxQuestions: 3,
      maxFlashcards: 3,
      baseUrl: 'http://localhost:1234/v1',
      model: 'fake',
      temperature: 0,
      generate: fakeGenerate,
    });
    expect(built.source).toBe('los');
    expect(built.questions.length).toBe(3);
    expect(built.flashcards.length).toBe(3);
    // IDs renumbered sequentially across LOS.
    expect(built.questions.map((q) => q.id)).toEqual(['ai-1', 'ai-2', 'ai-3']);
    expect(built.flashcards.map((f) => f.id)).toEqual(['flash-1', 'flash-2', 'flash-3']);
    // Locator chip carries the LOS text.
    expect(built.questions[0].locator.startsWith('LOS:')).toBe(true);
  });

  it('falls back to a stub when the generator throws', async () => {
    const fakeGenerate = async () => {
      throw new Error('boom');
    };
    const entry = l3Bank.find((e) => e.topic === 'asset-allocation');
    const built = await buildEntryFromLosTopic({
      topicEntry: entry,
      level: 'level3',
      questionsPerLos: 1,
      flashcardsPerLos: 1,
      maxQuestions: 5,
      maxFlashcards: 5,
      baseUrl: 'http://localhost:1234/v1',
      model: 'fake',
      temperature: 0,
      generate: fakeGenerate,
    });
    expect(built.source).toBe('los-stub');
    expect(built.questions.length).toBe(1);
    expect(built.flashcards.length).toBe(1);
    expect(built.questions[0].explanation).toContain('STUB');
  });
});
