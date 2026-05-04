import { describe, expect, it } from 'vitest';
import { cfaLevels, getCfaLevelContent, getCfaRuntimeReport } from './cfaLevels';

describe('CFA runtime content strategy', () => {
  it('loads validated authored Level I packs as beta runtime content without marking release eligible', () => {
    const level1 = getCfaLevelContent('level1');
    const runtime = getCfaRuntimeReport().levels.find((item) => item.level === 'level1');

    expect(runtime?.mode).toBe('validated-beta');
    expect(runtime?.releaseEligible).toBe(false);
    expect(level1.runtimeMode).toBe('validated-beta');
    expect(level1.topics).toHaveLength(10);
    expect(level1.topics.every((topic) => topic.runtimeMode === 'validated-beta')).toBe(true);
    expect(level1.topics.reduce((sum, topic) => sum + topic.questions.length, 0)).toBe(1000);
    expect(level1.topics.reduce((sum, topic) => sum + topic.vignettes.length, 0)).toBe(80);
    expect(level1.topics.reduce((sum, topic) => sum + topic.flashcards.length, 0)).toBe(1000);
  });

  it('exposes runtime labels to dashboard metadata separately from content maturity', () => {
    const level1Summary = cfaLevels.find((level) => level.id === 'level1');

    expect(level1Summary?.runtimeMode).toBe('validated-beta');
    expect(level1Summary?.runtimeLabel).toBe('Validated authored beta');
    expect(level1Summary?.topics.every((topic) => topic.runtimeMode === 'validated-beta')).toBe(true);
    expect(level1Summary?.topics.every((topic) => topic.maturity === 'validated')).toBe(true);
  });
});

