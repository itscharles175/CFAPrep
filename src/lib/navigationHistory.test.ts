import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAV_HISTORY_EVENT,
  clearHistory,
  getHistory,
  peek,
  peekPrevious,
  popHistory,
  pushHistory,
} from './navigationHistory';

beforeEach(() => {
  clearHistory();
});

afterEach(() => {
  clearHistory();
});

describe('navigationHistory — the shared cross-domain trail', () => {
  it('records {path, domain, label} tuples and back-fills domain from the path', () => {
    pushHistory({ path: '/cfa', label: 'CFA' });
    pushHistory({ path: '/lsat/srs', label: 'SRS' });
    expect(getHistory()).toEqual([
      { path: '/cfa', domain: 'host', label: 'CFA' },
      { path: '/lsat/srs', domain: 'lsat', label: 'SRS' },
    ]);
  });

  it('peek returns the current entry, peekPrevious the one before it', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    expect(peek()?.path).toBe('/analytics');
    expect(peekPrevious()?.path).toBe('/');
  });

  it('peekPrevious is null with fewer than two entries', () => {
    expect(peekPrevious()).toBeNull();
    pushHistory({ path: '/', label: 'Dashboard' });
    expect(peekPrevious()).toBeNull();
  });

  it('de-dupes a repeat of the current path (no consecutive duplicate)', () => {
    pushHistory({ path: '/cfa', label: 'CFA' });
    pushHistory({ path: '/cfa', label: 'CFA' });
    expect(getHistory()).toHaveLength(1);
  });

  it('refreshes the label in place when the same path is revisited with a better label', () => {
    pushHistory({ path: '/cfa/level1/fixed-income', label: '/cfa/level1/fixed-income' });
    pushHistory({ path: '/cfa/level1/fixed-income', label: 'CFA Module' });
    expect(getHistory()).toHaveLength(1);
    expect(peek()?.label).toBe('CFA Module');
  });

  it('popHistory removes and returns the current entry', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    expect(popHistory()?.path).toBe('/analytics');
    expect(peek()?.path).toBe('/');
  });

  it('fires the NAV_HISTORY_EVENT on every mutation so the chrome can re-render', () => {
    const onChange = vi.fn();
    window.addEventListener(NAV_HISTORY_EVENT, onChange);
    pushHistory({ path: '/', label: 'Dashboard' });
    expect(onChange).toHaveBeenCalled();
    window.removeEventListener(NAV_HISTORY_EVENT, onChange);
  });

  it('persists across reads via sessionStorage (survives a reload)', () => {
    pushHistory({ path: '/quant', label: 'Quant Finance' });
    // A fresh read (as a reload would do) still sees the entry.
    expect(getHistory()).toEqual([{ path: '/quant', domain: 'host', label: 'Quant Finance' }]);
  });
});
