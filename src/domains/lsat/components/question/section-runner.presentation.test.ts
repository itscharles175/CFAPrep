import { describe, expect, it } from 'vitest';
import {
  EXAM_RUNNER_COMPACT_BREAKPOINT,
  EXAM_RUNNER_HEADER_CLASS,
} from './sectionRunnerPresentation';

describe('timed section compact chrome contract', () => {
  it('uses a named header class and compact breakpoint for wrapped controls', () => {
    expect(EXAM_RUNNER_HEADER_CLASS).toBe('exam-runner-header');
    expect(EXAM_RUNNER_COMPACT_BREAKPOINT).toBe(1100);
  });
});
