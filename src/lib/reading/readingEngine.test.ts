import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBionic,
  applyReadingPrefs,
  clearReadingPrefs,
  unapplyBionic,
} from './readingEngine';
import { DEFAULT_READING_PREFS, type ReadingPrefs } from './readingPrefs';

const root = () => document.documentElement;

function prefs(patch: Partial<ReadingPrefs> = {}): ReadingPrefs {
  return { ...DEFAULT_READING_PREFS, ...patch };
}

beforeEach(() => {
  clearReadingPrefs();
  document.body.innerHTML = '';
});

afterEach(() => {
  clearReadingPrefs();
  document.body.innerHTML = '';
});

describe('applyReadingPrefs — <html> attribute application', () => {
  it('stamps no attributes for the neutral default (pure no-op)', () => {
    applyReadingPrefs(prefs());
    expect(root().hasAttribute('data-density')).toBe(false);
    expect(root().hasAttribute('data-reading-font')).toBe(false);
    expect(root().hasAttribute('data-text-spacing')).toBe(false);
    expect(root().hasAttribute('data-bionic')).toBe(false);
    expect(root().hasAttribute('data-line-focus')).toBe(false);
  });

  it('stamps data-density only when compact', () => {
    applyReadingPrefs(prefs({ density: 'compact' }));
    expect(root().getAttribute('data-density')).toBe('compact');
    applyReadingPrefs(prefs({ density: 'comfortable' }));
    expect(root().hasAttribute('data-density')).toBe(false);
  });

  it('stamps the reading-aid attributes when enabled', () => {
    applyReadingPrefs(
      prefs({ dyslexiaFont: true, textSpacing: true, bionicReading: true }),
    );
    expect(root().getAttribute('data-reading-font')).toBe('dyslexic');
    expect(root().getAttribute('data-text-spacing')).toBe('on');
    expect(root().getAttribute('data-bionic')).toBe('on');
  });

  it('mounts the line-focus ruler element only while line-focus is on', () => {
    applyReadingPrefs(prefs({ lineFocus: true }));
    expect(document.getElementById('qv-line-focus-ruler')).not.toBeNull();
    expect(root().getAttribute('data-line-focus')).toBe('on');

    applyReadingPrefs(prefs({ lineFocus: false }));
    expect(document.getElementById('qv-line-focus-ruler')).toBeNull();
    expect(root().hasAttribute('data-line-focus')).toBe(false);
  });

  it('is idempotent — re-applying the same prefs leaves one ruler', () => {
    applyReadingPrefs(prefs({ lineFocus: true }));
    applyReadingPrefs(prefs({ lineFocus: true }));
    expect(document.querySelectorAll('#qv-line-focus-ruler')).toHaveLength(1);
  });
});

describe('applyBionic / unapplyBionic — reversible text pass', () => {
  it('wraps word fixations in marked <b> elements', () => {
    const container = document.createElement('div');
    container.textContent = 'reading anchors';
    document.body.appendChild(container);
    applyBionic(container);
    const bolds = container.querySelectorAll('b[data-qv-bionic]');
    expect(bolds.length).toBeGreaterThan(0);
    // The full visible text is unchanged.
    expect(container.textContent).toBe('reading anchors');
  });

  it('does not corrupt code / KaTeX regions', () => {
    const container = document.createElement('div');
    const code = document.createElement('code');
    code.textContent = 'const x = 1;';
    container.appendChild(code);
    document.body.appendChild(container);
    applyBionic(container);
    expect(code.querySelector('b[data-qv-bionic]')).toBeNull();
    expect(code.textContent).toBe('const x = 1;');
  });

  it('round-trips: unapplyBionic restores the original text nodes', () => {
    const container = document.createElement('div');
    container.textContent = 'inclusive reading mode';
    document.body.appendChild(container);
    applyBionic(container);
    unapplyBionic(container);
    expect(container.querySelectorAll('b[data-qv-bionic]')).toHaveLength(0);
    expect(container.textContent).toBe('inclusive reading mode');
  });

  it('is idempotent — applying twice does not double-wrap', () => {
    const container = document.createElement('div');
    container.textContent = 'double pass';
    document.body.appendChild(container);
    applyBionic(container);
    const first = container.querySelectorAll('b[data-qv-bionic]').length;
    applyBionic(container);
    expect(container.querySelectorAll('b[data-qv-bionic]').length).toBe(first);
  });
});
