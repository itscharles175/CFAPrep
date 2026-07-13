import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_READING_PREFS,
  getStoredReadingPrefs,
  normalizeReadingPrefs,
  storeReadingPrefs,
} from './readingPrefs';

const KEY = 'qv-reading-prefs';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('normalizeReadingPrefs — tolerant coercion', () => {
  it('fills every field from defaults for an empty/invalid blob', () => {
    expect(normalizeReadingPrefs(undefined)).toEqual(DEFAULT_READING_PREFS);
    expect(normalizeReadingPrefs(null)).toEqual(DEFAULT_READING_PREFS);
    expect(normalizeReadingPrefs('garbage')).toEqual(DEFAULT_READING_PREFS);
  });

  it('keeps valid fields and replaces invalid ones', () => {
    const result = normalizeReadingPrefs({
      density: 'compact',
      dyslexiaFont: true,
      textSpacing: 'yes', // invalid type → default false
      bionicReading: false,
    });
    expect(result.density).toBe('compact');
    expect(result.dyslexiaFont).toBe(true);
    expect(result.textSpacing).toBe(false);
    expect(result.bionicReading).toBe(false);
    expect(result.lineFocus).toBe(false);
  });

  it('rejects an unknown density value', () => {
    expect(normalizeReadingPrefs({ density: 'cozy' }).density).toBe('comfortable');
  });
});

describe('persistence round-trip', () => {
  it('stores and re-reads the same prefs', () => {
    const value = {
      density: 'compact' as const,
      dyslexiaFont: true,
      textSpacing: true,
      bionicReading: false,
      lineFocus: true,
    };
    storeReadingPrefs(value);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(value);
    expect(getStoredReadingPrefs()).toEqual(value);
  });

  it('defaults cleanly when nothing is stored', () => {
    expect(getStoredReadingPrefs()).toEqual(DEFAULT_READING_PREFS);
  });

  it('defaults cleanly when the stored JSON is corrupt', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(getStoredReadingPrefs()).toEqual(DEFAULT_READING_PREFS);
  });
});
