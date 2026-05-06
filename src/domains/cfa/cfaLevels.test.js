import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cfaLevels, getCfaLevelContent, getCfaRuntimeReport } from './cfaLevels';
import { loadCfaLevelContent, loadCfaMockExam, loadCfaTopicContent } from './cfaLoaders';
import { cfaLevels as cfaLevelSummaries } from './cfaSummary';

const cfaDir = dirname(fileURLToPath(import.meta.url));

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

  it('loads editorial exam-ready Level III constructed-response packs as release-eligible runtime content', () => {
    const level3 = getCfaLevelContent('level3');
    const runtime = getCfaRuntimeReport().levels.find((item) => item.level === 'level3');

    expect(runtime?.mode).toBe('exam-ready');
    expect(runtime?.releaseEligible).toBe(true);
    expect(runtime?.topicCount).toBe(6);
    expect(level3.runtimeMode).toBe('exam-ready');
    expect(level3.topics).toHaveLength(6);
    expect(level3.topics.every((topic) => topic.runtimeMode === 'exam-ready')).toBe(true);
    expect(level3.topics.reduce((sum, topic) => sum + topic.constructedResponses.length, 0)).toBe(18);
    expect(level3.topics.reduce((sum, topic) => sum + topic.vignettes.length, 0)).toBe(24);
    expect(level3.topics.reduce((sum, topic) => sum + topic.vignettes.reduce((questionSum, vignette) => questionSum + vignette.questions.length, 0), 0)).toBe(72);
    expect(level3.topics.reduce((sum, topic) => sum + topic.flashcards.length, 0)).toBe(192);
  });

  it('loads Level III topics through async content APIs', async () => {
    const level3Summary = cfaLevelSummaries.find((level) => level.id === 'level3');
    const level3 = await loadCfaLevelContent('level3');
    const performance = await loadCfaTopicContent('level3', 'performance');
    const mock = await loadCfaMockExam('level3');

    expect(level3Summary?.topics).toHaveLength(6);
    expect(level3Summary?.topics.find((topic) => topic.id === 'performance')?.constructedResponses).toBe(3);
    expect(level3.topics.find((topic) => topic.id === 'performance')).toBe(performance);
    expect(performance?.runtimeMode).toBe('exam-ready');
    expect(performance?.constructedResponses).toHaveLength(3);
    expect(mock?.constructedResponseIds.length).toBeGreaterThan(0);
  });

  it('keeps route components off synchronous all-level CFA content imports', () => {
    const routeFiles = ['CfaDashboard.jsx', 'CfaModule.jsx', 'CfaQuiz.jsx', 'CfaVignette.jsx', 'CfaConstructedResponse.jsx'];
    routeFiles.forEach((fileName) => {
      const source = readFileSync(join(cfaDir, fileName), 'utf8');
      expect(source).not.toMatch(/from ['"].*cfaLevels['"]/);
      expect(source).not.toContain('cfaLevelContent');
    });
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
