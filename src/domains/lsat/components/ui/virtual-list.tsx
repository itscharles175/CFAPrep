import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

export interface VirtualListProps<T> {
  items: T[];
  estimateSize: number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  /** Max height of the scroll container (px). Defaults to 70vh. */
  maxHeight?: number | string;
  overscan?: number;
  /**
   * Required: stable item identity function. Must NOT use the index alone —
   * index keys are unsafe for lists that can reorder or splice (e.g. after
   * a quarantine approval or an optimistic update).
   */
  getItemKey: (item: T, index: number) => string | number;
}

/** Scrollable virtualized list — use for long error-log / bank rows. */
export function VirtualList<T>({
  items,
  estimateSize,
  renderItem,
  className,
  maxHeight = "70vh",
  overscan = 6,
  getItemKey,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (i) => getItemKey(items[i], i),
  });

  return (
    <div
      ref={parentRef}
      className={cn("overflow-y-auto", className)}
      style={{ maxHeight }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => (
          <div
            key={vRow.key}
            data-index={vRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vRow.start}px)`,
            }}
          >
            {renderItem(items[vRow.index], vRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
