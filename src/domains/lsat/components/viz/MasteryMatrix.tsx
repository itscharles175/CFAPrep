import { memo, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMs, pct } from "@/lib/utils";
import type { QType } from "@/lib/types";
import { TypeBadge } from "./TypeBadge";

export interface MasteryRow {
  q_type: QType;
  /** 0..1 */
  accuracy: number;
  /** milliseconds */
  avgTimeMs: number;
  volume: number;
}

export interface MasteryMatrixProps {
  rows: MasteryRow[];
  /** Primary row action (R9 §5: focus the cross-filter on this type). */
  onSelect?: (row: MasteryRow) => void;
  /**
   * R9 §5 — optional secondary per-row action (e.g. drill the type in the error
   * log). Renders a trailing affordance so the primary row click can focus the
   * charts instead of navigating away.
   */
  onDrill?: (row: MasteryRow) => void;
  /** Type currently focused by the cross-filter (highlights its row). */
  focusedType?: QType;
  className?: string;
  /** Label for the score column (e.g. "Mastery" when fed adjusted scores). */
  accuracyLabel?: string;
}

type SortKey = "q_type" | "accuracy" | "avgTimeMs" | "volume";

/** Sortable grid of question types × (accuracy, avg-time, volume); clickable rows. */
function MasteryMatrixInner({
  rows,
  onSelect,
  onDrill,
  focusedType,
  className,
  accuracyLabel = "Accuracy",
}: MasteryMatrixProps) {
  const [sortKey, setSortKey] = useState<SortKey>("accuracy");
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      let cmp: number;
      if (sortKey === "q_type") cmp = String(a.q_type).localeCompare(String(b.q_type));
      else cmp = a[sortKey] - b[sortKey];
      return asc ? cmp : -cmp;
    });
    return out;
  }, [rows, sortKey, asc]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(true);
    }
  };

  const Th = ({ k, label, align = "left" }: { k: SortKey; label: string; align?: "left" | "right" }) => (
    <th
      className={cn(
        "type-overline cursor-pointer select-none px-3 py-2 text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
      )}
      onClick={() => toggle(k)}
    >
      <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
        {label}
        {sortKey === k &&
          (asc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  );

  return (
    <div className={cn("overflow-hidden rounded-card border bg-card", className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <Th k="q_type" label="Type" />
            <Th k="accuracy" label={accuracyLabel} align="right" />
            <Th k="avgTimeMs" label="Avg time" align="right" />
            <Th k="volume" label="Volume" align="right" />
            {onDrill && <th className="w-8 px-2 py-2" aria-label="Drill" />}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const focused = focusedType === r.q_type;
            return (
              <tr
                key={String(r.q_type)}
                className={cn(
                  "border-b border-border/60 last:border-0 transition-colors",
                  onSelect && "cursor-pointer hover:bg-accent",
                  focused && "bg-primary-subtle",
                )}
                aria-selected={focused || undefined}
                onClick={() => onSelect?.(r)}
              >
                <td className="px-3 py-2">
                  <TypeBadge qType={r.q_type} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.accuracy)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatMs(r.avgTimeMs)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {r.volume}
                </td>
                {onDrill && (
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      className="inline-flex items-center rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      // Don't let the drill click also trigger the row's focus.
                      onClick={(e) => {
                        e.stopPropagation();
                        onDrill(r);
                      }}
                      aria-label={`Drill ${String(r.q_type)} in error log`}
                      title="Open in error log"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A2.4 — memoized so a parent re-render (stale-data dim, compare toggle, or the
// tab simply staying mounted under lazy-keep-alive) doesn't re-run the sort/
// layout unless the rows/focus/handlers actually change identity.
export const MasteryMatrix = memo(MasteryMatrixInner);
MasteryMatrix.displayName = "MasteryMatrix";
