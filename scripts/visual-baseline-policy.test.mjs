import { describe, expect, it } from 'vitest';
import {
  evaluateVisualBaselinePolicy,
  expectedVisualBaselineNames,
  visualBaselineName,
} from './visual-baseline-policy.mjs';

describe('visual baseline policy', () => {
  it('derives stable baseline names from route, theme, and viewport', () => {
    expect(visualBaselineName({ id: 'style', theme: 'dark', viewport: 'mobile' })).toBe(
      'style-dark-mobile.png',
    );
    expect(
      expectedVisualBaselineNames({
        routes: [{ id: 'style' }, { id: 'today' }],
        themes: ['dark', 'light'],
        viewports: ['desktop', 'mobile'],
      }),
    ).toEqual([
      'style-dark-desktop.png',
      'style-dark-mobile.png',
      'style-light-desktop.png',
      'style-light-mobile.png',
      'today-dark-desktop.png',
      'today-dark-mobile.png',
      'today-light-desktop.png',
      'today-light-mobile.png',
    ]);
  });

  it('fails closed when any required baseline is missing', () => {
    const result = evaluateVisualBaselinePolicy({
      expectedNames: ['style-dark-desktop.png', 'style-light-desktop.png'],
      existingNames: ['style-dark-desktop.png'],
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.missing).toEqual(['style-light-desktop.png']);
    expect(result.reason).toMatch(/required visual baseline/);
  });

  it('allows deliberate rebaselining only when update mode is set', () => {
    const result = evaluateVisualBaselinePolicy({
      expectedNames: ['style-dark-desktop.png'],
      existingNames: [],
      updateBaselines: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('update');
    expect(result.missing).toEqual(['style-dark-desktop.png']);
  });

  it('blocks empty expected matrices because they make the gate meaningless', () => {
    const result = evaluateVisualBaselinePolicy({
      expectedNames: [],
      existingNames: [],
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/no expected baseline/);
  });
});
