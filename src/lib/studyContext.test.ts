import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STUDY_CONTEXT,
  contextSwitchHref,
  domainForLocation,
  normalizeStudyContext,
  readStudyContext,
  rememberStudyContextRoute,
  studyContextReturnHref,
  workspaceHref,
  writeStudyContext,
} from './studyContext';

beforeEach(() => localStorage.clear());

describe('study context', () => {
  it('normalizes invalid persisted values without discarding valid selections', () => {
    expect(normalizeStudyContext({ domain: 'lsat', cfaLevel: 'level9', goal: 'retention' })).toEqual({
      domain: 'lsat',
      cfaLevel: 'level1',
      goal: 'retention',
    });
    expect(normalizeStudyContext(null)).toEqual(DEFAULT_STUDY_CONTEXT);
  });

  it('persists partial updates and keeps the remaining context', () => {
    writeStudyContext({ cfaLevel: 'level3', goal: 'exam-readiness' });
    writeStudyContext({ domain: 'quant' });
    expect(readStudyContext()).toEqual({ domain: 'quant', cfaLevel: 'level3', goal: 'exam-readiness' });
  });

  it('builds workspace destinations from the selected track and CFA level', () => {
    const cfa = { domain: 'cfa', cfaLevel: 'level2', goal: 'balanced' } as const;
    expect(workspaceHref('practice', cfa)).toBe('/cfa/level2/mock');
    expect(workspaceHref('learn', cfa)).toBe('/cfa');

    const lsat = { ...cfa, domain: 'lsat' } as const;
    expect(workspaceHref('practice', lsat)).toBe('/lsat/practice');
    expect(workspaceHref('learn', lsat)).toBe('/lsat/dashboard');
    expect(workspaceHref('review', lsat)).toBe('/lsat/review');
    expect(workspaceHref('progress', lsat)).toBe('/lsat/analytics');

    expect(workspaceHref('practice', { ...cfa, domain: 'quant' })).toBe('/quant/risk-management');
    expect(workspaceHref('practice', { ...cfa, domain: 'excel' })).toBe('/excel/dcf-modeling');
  });

  it('keeps a separate return point for each curriculum and workspace', () => {
    rememberStudyContextRoute('lsat', 'learn', '/lsat/rc-lab');
    rememberStudyContextRoute('lsat', 'practice', '/lsat/drills');
    rememberStudyContextRoute('cfa', 'learn', '/cfa/level2/equity');

    const lsat = { domain: 'lsat', cfaLevel: 'level1', goal: 'balanced' } as const;
    expect(studyContextReturnHref('lsat', 'learn')).toBe('/lsat/rc-lab');
    expect(contextSwitchHref('learn', lsat)).toBe('/lsat/rc-lab');
    expect(contextSwitchHref('practice', lsat)).toBe('/lsat/drills');
    expect(contextSwitchHref('learn', { ...lsat, domain: 'cfa' })).toBe('/cfa/level2/equity');
  });

  it('recognizes domains from existing deep links', () => {
    expect(domainForLocation('/cfa/level3/performance')).toBe('cfa');
    expect(domainForLocation('/lsat/blind-review/session-1')).toBe('lsat');
    expect(domainForLocation('/library/tutor')).toBeNull();
  });
});
