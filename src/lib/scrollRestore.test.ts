import { afterEach, describe, expect, it } from 'vitest';
import { saveScroll, restoreScroll } from './scrollRestore';

// UX-1 — unit coverage for the host scroll-restoration store. The pure
// save/restore helpers are the cross-domain-hop primitive: main.jsx tears down
// and remounts the host sub-app on a soft-hop, so the position has to survive in
// sessionStorage rather than relying on the browser's native restoration.

const KEY = 'studyvault.scroll.';

afterEach(() => {
  // Keep cases independent — clear only this module's namespaced keys.
  for (let i = window.sessionStorage.length - 1; i >= 0; i -= 1) {
    const k = window.sessionStorage.key(i);
    if (k && k.startsWith(KEY)) window.sessionStorage.removeItem(k);
  }
});

describe('saveScroll / restoreScroll round-trip', () => {
  it('persists a route offset and reads it back', () => {
    saveScroll('host:/today', 420);
    expect(restoreScroll('host:/today')).toBe(420);
  });

  it('keys are per-route — one route does not leak into another', () => {
    saveScroll('host:/today', 100);
    saveScroll('host:/review', 250);
    expect(restoreScroll('host:/today')).toBe(100);
    expect(restoreScroll('host:/review')).toBe(250);
  });

  it('returns 0 for a never-saved route', () => {
    expect(restoreScroll('host:/never-visited')).toBe(0);
  });

  it('writes under the studyvault namespace (distinct from the LSAT lsatlab. prefix)', () => {
    saveScroll('host:/', 30);
    expect(window.sessionStorage.getItem('studyvault.scroll.host:/')).toBe('30');
    expect(window.sessionStorage.getItem('lsatlab.scroll.host:/')).toBeNull();
  });
});

describe('value normalisation', () => {
  it('rounds a fractional offset to an integer', () => {
    saveScroll('host:/today', 199.7);
    expect(restoreScroll('host:/today')).toBe(200);
  });

  it('clamps a negative (overscroll bounce) offset to 0 on save', () => {
    saveScroll('host:/today', -40);
    expect(restoreScroll('host:/today')).toBe(0);
  });

  it('treats a corrupt stored value as 0', () => {
    window.sessionStorage.setItem('studyvault.scroll.host:/today', 'not-a-number');
    expect(restoreScroll('host:/today')).toBe(0);
  });

  it('normalises an empty path to the root key', () => {
    saveScroll('', 77);
    expect(window.sessionStorage.getItem('studyvault.scroll./')).toBe('77');
    expect(restoreScroll('')).toBe(77);
  });
});
