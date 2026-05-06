import { describe, expect, it } from 'vitest';
import { cfaLevels, getCfaLevelContent, getCfaRuntimeReport } from './cfaLevels';
import { loadCfaLevelContent, loadCfaMockExam, loadCfaTopicContent } from './cfaLoaders';
import { cfaLevels as cfaLevelSummaries } from './cfaSummary';

describe('CFA runtime content strategy', () => {
  it('loads editorial exam-ready Level I packs as release-eligible runtime content', () => {
    const level1 = getCfaLevelContent('level1');
    const runtime = getCfaRuntimeReport().levels.find((item) => item.level === 'level1');

    expect(runtime?.mode).toBe('exam-ready');
    expect(runtime?.releaseEligible).toBe(true);
    expect(level1.runtimeMode).toBe('exam-ready');
    expect(level1.topics).toHaveLength(10);
    expect(level1.topics.every((topic) => topic.runtimeMode === 'exam-ready')).toBe(true);
    expect(level1.topics.reduce((sum, topic) => sum + topic.questions.length, 0)).toBe(1000);
    expect(level1.topics.reduce((sum, topic) => sum + topic.vignettes.length, 0)).toBe(80);
    expect(level1.topics.reduce((sum, topic) => sum + topic.flashcards.length, 0)).toBe(1000);
  });

  it('exposes runtime labels to dashboard metadata separately from content maturity', () => {
    const level1Summary = cfaLevels.find((level) => level.id === 'level1');

    expect(level1Summary?.runtimeMode).toBe('exam-ready');
    expect(level1Summary?.runtimeLabel).toBe('Editorial exam-ready');
    expect(level1Summary?.topics.every((topic) => topic.runtimeMode === 'exam-ready')).toBe(true);
    expect(level1Summary?.topics.every((topic) => topic.maturity === 'exam-ready')).toBe(true);
  });

  it('loads editorial exam-ready Level II item-set packs as release-eligible runtime content', () => {
    const level2 = getCfaLevelContent('level2');
    const runtime = getCfaRuntimeReport().levels.find((item) => item.level === 'level2');

    expect(runtime?.mode).toBe('exam-ready');
    expect(runtime?.releaseEligible).toBe(true);
    expect(level2.runtimeMode).toBe('exam-ready');
    expect(level2.topics).toHaveLength(10);
    expect(level2.topics.every((topic) => topic.runtimeMode === 'exam-ready')).toBe(true);
    expect(level2.topics.reduce((sum, topic) => sum + topic.vignettes.length, 0)).toBe(120);
    expect(level2.topics.reduce((sum, topic) => sum + topic.vignettes.reduce((questionSum, vignette) => questionSum + vignette.questions.length, 0), 0)).toBe(480);
    expect(level2.topics.reduce((sum, topic) => sum + topic.flashcards.length, 0)).toBe(400);
  });

  it('keeps CFA summaries lightweight while async loaders return route-ready content', async () => {
    const level2Summary = cfaLevelSummaries.find((level) => level.id === 'level2');
    const level2 = await loadCfaLevelContent('level2');
    const equity = await loadCfaTopicContent('level2', 'equity');
    const mock = await loadCfaMockExam('level2');

    expect(level2Summary?.topics.find((topic) => topic.id === 'equity')?.vignettes).toBe(12);
    expect(level2.topics.find((topic) => topic.id === 'equity')).toBe(equity);
    expect(equity?.runtimeMode).toBe('exam-ready');
    expect(equity?.vignettes).toHaveLength(12);
    expect(mock?.vignetteIds.length).toBeGreaterThan(0);
  });
});
