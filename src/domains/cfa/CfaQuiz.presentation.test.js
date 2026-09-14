import { describe, expect, it } from 'vitest';
import { CFA_QUIZ_ACTION_STYLE } from './cfaQuizPresentation';

describe('CFA quiz presentation contract', () => {
  it('keeps the answer decision visible during question scrolling', () => {
    expect(CFA_QUIZ_ACTION_STYLE.position).toBe('sticky');
    expect(CFA_QUIZ_ACTION_STYLE.bottom).toBe('var(--space-4)');
    expect(CFA_QUIZ_ACTION_STYLE.zIndex).toBeGreaterThan(0);
    expect(CFA_QUIZ_ACTION_STYLE.background).toContain('var(--bg-primary)');
  });
});
