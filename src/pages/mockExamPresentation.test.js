import { describe, expect, it } from 'vitest';
import { getFinishSectionHint, getMockExamProgress } from './mockExamPresentation';

describe('CFA mock assessment presentation contract', () => {
  it('keeps response-unit and section-item denominators explicit', () => {
    expect(getMockExamProgress({ answered: 0, totalResponses: 42, currentItem: 1, totalItems: 18 })).toEqual({
      answered: '0/42',
      answeredDetail: '42 response units in this section',
      item: '1/18',
      itemDetail: 'Current section item',
      progress: '6%',
      progressDetail: '1/18 section items',
      railDetail: '1/18 items · 0/42 responses',
    });
  });

  it('clamps impossible item positions before calculating progress', () => {
    expect(getMockExamProgress({ answered: 2, totalResponses: 4, currentItem: 99, totalItems: 18 })).toMatchObject({
      item: '18/18',
      progress: '100%',
      progressDetail: '18/18 section items',
    });
  });

  it('explains why finish is disabled before the first response', () => {
    expect(getFinishSectionHint(0)).toBe('Answer at least one item to enable Finish Section.');
    expect(getFinishSectionHint(1)).toBe('');
  });
});
