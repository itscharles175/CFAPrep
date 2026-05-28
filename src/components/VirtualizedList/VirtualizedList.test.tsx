/**
 * VirtualizedList tests.
 *
 * jsdom doesn't lay out, so `scrollTop` is just a settable property — we set
 * it directly and dispatch a scroll event to advance the visible window.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualizedList from './VirtualizedList';

interface Row {
  id: string;
  label: string;
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }));
}

// Make requestAnimationFrame synchronous so a single fireEvent.scroll triggers
// a re-render immediately.
beforeAll(() => {
  // jsdom binds raf as a no-op timer; replacing it lets the scroll listener
  // run synchronously inside `act`.
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
  (globalThis as unknown as { cancelAnimationFrame: (handle: number) => void }).cancelAnimationFrame = () => undefined;
});

beforeEach(() => {
  // Spy on the scroll handler so we can assert it was hit.
});

afterEach(() => {
  vi.restoreAllMocks();
});

function findRenderedIndices(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-virtualized-index]'))
    .map((el) => Number(el.dataset.virtualizedIndex))
    .sort((a, b) => a - b);
}

describe('VirtualizedList — window', () => {
  it('renders only the visible window when items overflow the viewport', () => {
    const rows = makeRows(500);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={200}
        overscan={0}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
        data-testid="vl"
      />,
    );
    const container = screen.getByTestId('vl');
    // With overscan=0, height=200, itemHeight=40 → exactly 5 rows visible.
    const indices = findRenderedIndices(container);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
    expect(container.querySelectorAll('[data-virtualized-index]').length).toBe(5);
  });

  it('renders all items when items.length * itemHeight < height', () => {
    const rows = makeRows(3);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={400}
        overscan={6}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
        data-testid="vl"
      />,
    );
    const container = screen.getByTestId('vl');
    expect(findRenderedIndices(container)).toEqual([0, 1, 2]);
    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.getByText('Row 1')).toBeInTheDocument();
    expect(screen.getByText('Row 2')).toBeInTheDocument();
  });
});

describe('VirtualizedList — overscan', () => {
  it('adds buffer items above and below the visible window when scrolled', () => {
    const rows = makeRows(200);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={200}
        overscan={3}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
        data-testid="vl"
      />,
    );
    const container = screen.getByTestId('vl');
    // Force a scroll to the middle of the list.
    Object.defineProperty(container, 'scrollTop', { value: 800, writable: true });
    act(() => {
      fireEvent.scroll(container);
    });
    const indices = findRenderedIndices(container);
    // Visible window covers rows 20..25 (scrollTop=800/itemHeight=40 → 20;
    // bottom edge at 1000 → 25).  Overscan=3 adds [-3, +3] →  17..27 inclusive.
    expect(indices[0]).toBe(17);
    expect(indices[indices.length - 1]).toBe(27);
    // Total = 17..27 inclusive = 11 items.
    expect(indices.length).toBe(11);
  });

  it('clamps overscan at the top and bottom of the list', () => {
    const rows = makeRows(8);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={200}
        overscan={10}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
        data-testid="vl"
      />,
    );
    const container = screen.getByTestId('vl');
    // Overscan would extend below the end of the list — we expect to see all
    // 8 rows, no negative or out-of-bounds indices.
    expect(findRenderedIndices(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('VirtualizedList — renderItem contract', () => {
  it('passes (item, index) pairs to renderItem in the right order', () => {
    const rows = makeRows(5);
    const seen: Array<{ id: string; index: number }> = [];
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={400}
        overscan={6}
        renderItem={(row, idx) => {
          seen.push({ id: row.id, index: idx });
          return <span>{row.label}</span>;
        }}
        itemKey={(row) => row.id}
      />,
    );
    expect(seen).toEqual([
      { id: 'row-0', index: 0 },
      { id: 'row-1', index: 1 },
      { id: 'row-2', index: 2 },
      { id: 'row-3', index: 3 },
      { id: 'row-4', index: 4 },
    ]);
  });

  it('uses itemKey to drive React keys (no duplicate-key warnings)', () => {
    const rows = makeRows(3);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={400}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
      />,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('VirtualizedList — total spacer', () => {
  it('inner spacer height = items.length * itemHeight', () => {
    const rows = makeRows(50);
    render(
      <VirtualizedList
        items={rows}
        itemHeight={40}
        height={200}
        renderItem={(row) => <span>{row.label}</span>}
        itemKey={(row) => row.id}
        data-testid="vl"
      />,
    );
    const container = screen.getByTestId('vl');
    const spacer = container.firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${50 * 40}px`);
  });
});
