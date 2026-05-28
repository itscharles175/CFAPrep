/**
 * Tiny intrinsic virtualizer for long, fixed-height lists.
 *
 * Why no `react-window`?  Keeping the bundle small matters and our needs are
 * narrow — fixed-height items, a single vertical axis, and ~hundreds (not
 * tens of thousands) of rows.  This implementation is ~80 lines and ships
 * with zero new dependencies.
 *
 * Mechanics:
 *   - Outer container has `overflow-y: auto` and a fixed `height` so the
 *     scrollbar is correct.
 *   - Inner spacer is `items.length * itemHeight` tall so the browser's
 *     scrollbar geometry matches what the user expects.
 *   - On scroll we compute `[start, end)` from `scrollTop` and render only
 *     that slice, positioned with `position: absolute; top: ...` inside the
 *     spacer.  Overscan adds buffer rows above and below the visible window.
 *   - Scroll handler is throttled via `requestAnimationFrame` so rapid
 *     scrolls coalesce into one re-render per frame.
 */

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface VirtualizedListProps<T> {
  items: T[];
  /** Pixel height of each item — must be fixed for the math to work. */
  itemHeight: number;
  /** Viewport height in pixels.  Defaults to 480. */
  height?: number;
  /** Extra rows rendered above and below the visible window.  Defaults to 6. */
  overscan?: number;
  /** Renders a single item.  Index is the item's index in the source array. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Extra class names on the scrolling container. */
  className?: string;
  /** Inline styles merged into the scrolling container. */
  style?: CSSProperties;
  /**
   * Optional key extractor.  Defaults to using the array index — caller
   * should provide a stable key when items can be reordered or filtered.
   */
  itemKey?: (item: T, index: number) => string | number;
  /** Aria role for the scrolling container.  Defaults to `list`. */
  role?: string;
  /** Optional data-testid pass-through to make the container easy to grab. */
  'data-testid'?: string;
}

function computeWindow(
  scrollTop: number,
  itemHeight: number,
  viewportHeight: number,
  overscan: number,
  total: number,
): { start: number; end: number } {
  if (total === 0 || itemHeight <= 0) return { start: 0, end: 0 };
  const visibleStart = Math.floor(scrollTop / itemHeight);
  const visibleEnd = Math.ceil((scrollTop + viewportHeight) / itemHeight);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(total, visibleEnd + overscan);
  return { start, end };
}

export default function VirtualizedList<T>({
  items,
  itemHeight,
  height = 480,
  overscan = 6,
  renderItem,
  className,
  style,
  itemKey,
  role = 'list',
  'data-testid': testId,
}: VirtualizedListProps<T>): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);

  const totalHeight = items.length * itemHeight;

  const { start, end } = useMemo(
    () => computeWindow(scrollTop, itemHeight, height, overscan, items.length),
    [scrollTop, itemHeight, height, overscan, items.length],
  );

  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const node = containerRef.current;
      if (node) setScrollTop(node.scrollTop);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const slice = useMemo(() => {
    const out: ReactNode[] = [];
    for (let i = start; i < end; i++) {
      const item = items[i];
      const key = itemKey ? itemKey(item, i) : i;
      const top = i * itemHeight;
      out.push(
        <div
          key={key}
          style={{
            position: 'absolute',
            top,
            left: 0,
            right: 0,
            height: itemHeight,
          }}
          role={role === 'list' ? 'listitem' : undefined}
          data-virtualized-index={i}
        >
          {renderItem(item, i)}
        </div>,
      );
    }
    return out;
  }, [items, start, end, itemHeight, renderItem, itemKey, role]);

  const containerStyle: CSSProperties = {
    position: 'relative',
    overflowY: 'auto',
    height,
    ...style,
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      role={role}
      onScroll={onScroll}
      data-testid={testId}
    >
      <div style={{ position: 'relative', height: totalHeight, width: '100%' }}>
        {slice}
      </div>
    </div>
  );
}
