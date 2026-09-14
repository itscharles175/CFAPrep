import { describe, expect, it } from 'vitest';
import { CFA_QUIZ_ACTION_STYLE } from './cfaQuizPresentation';

describe('CFA quiz presentation contract', () => {
  it('keeps the primary action in flow so feedback cannot be covered', () => {
    expect(CFA_QUIZ_ACTION_STYLE.position).toBe('static');
    expect(CFA_QUIZ_ACTION_STYLE.zIndex).toBe('auto');
    expect(CFA_QUIZ_ACTION_STYLE.background).toBe('transparent');
  });
});
