import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatMs } from "@/lib/utils";
import { qTypeLabel, typeColor } from "@/lib/labels";
import { getNavigatorMode, type NavigatorMode } from "@/lib/prefs";
import type { QType } from "@/lib/types";

export interface NavItem {
  /** Whether the question has a chosen answer. */
  answered: boolean;
  flagged: boolean;
  /** Whether any choice has been eliminated. */
  hasEliminations: boolean;
  /** Accumulated time on this question (ms). */
  timeMs: number;
  qType?: QType;
  /** Hover preview (stem snippet). */
  previewText?: string;
}

export interface NavigatorStripProps {
  count: number;
  current: number;
  onJump: (index: number) => void;
  /** Rich per-item state. If omitted, falls back to answered/flagged sets. */
  items?: NavItem[];
  /** Override persisted navigator mode. */
  mode?: NavigatorMode;
  // Back-compat (TakeSection legacy path): plain sets.
  answered?: Set<number>;
  flagged?: Set<number>;
}

function sizeClass(timeMs: number, mode: NavigatorMode): string {
  if (mode !== "time" || timeMs <= 0) return "h-7 w-7";
  const sec = timeMs / 1000;
  if (sec > 120) return "h-9 w-9";
  if (sec > 90) return "h-8 w-8";
  return "h-7 w-7";
}

/**
 * R9 (docs/19 zen focus mode) — the navigator collapsed to a thin progress
 * dot-row. In distraction-free mode the full numbered strip is replaced by this
 * minimal ribbon: one small dot per question (answered = filled, flagged =
 * amber, current = a wider pill), so the only persistent navigation cue is calm
 * and ambient. Each dot stays a real button (keyboard-reachable jump). It shows
 * answered/flagged PROGRESS only — never any correctness — so it is Test-Mode
 * safe (it appears during the timed section).
 */
export function ProgressDots({
  count,
  current,
  items,
  onJump,
}: {
  count: number;
  current: number;
  items?: NavItem[];
  onJump: (index: number) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1.5"
      role="group"
      aria-label="Question progress"
    >
      {Array.from({ length: count }, (_, i) => {
        const it = items?.[i];
        const isCurrent = i === current;
        const answered = it?.answered ?? false;
        const flagged = it?.flagged ?? false;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onJump(i)}
            aria-label={`Question ${i + 1}${flagged ? ", flagged" : ""}${answered ? ", answered" : ""}${isCurrent ? ", current" : ""}`}
            aria-current={isCurrent ? "true" : undefined}
            className={cn(
              "h-1.5 rounded-full transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isCurrent ? "w-5" : "w-1.5",
              flagged
                ? "bg-warning"
                : isCurrent
                  ? "bg-primary"
                  : answered
                    ? "bg-foreground/55"
                    : "bg-foreground/20 hover:bg-foreground/40",
            )}
          />
        );
      })}
    </div>
  );
}

function NavigatorStripImpl({
  count,
  current,
  onJump,
  items,
  mode: modeProp,
  answered,
  flagged,
}: NavigatorStripProps) {
  const [hover, setHover] = useState<number | null>(null);
  const mode = modeProp ?? getNavigatorMode();

  function itemFor(i: number): NavItem {
    if (items && items[i]) return items[i];
    return {
      answered: answered?.has(i) ?? false,
      flagged: flagged?.has(i) ?? false,
      hasEliminations: false,
      timeMs: 0,
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {Array.from({ length: count }, (_, i) => {
        const it = itemFor(i);
        const isCurrent = i === current;
        const dot = it.qType ? typeColor(it.qType) : undefined;
        const typeFill = mode === "type" && dot;

        return (
          <div key={i} className="relative">
            <button
              onClick={() => onJump(i)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
              aria-label={`Question ${i + 1}${it.flagged ? ", flagged" : ""}${
                it.answered ? ", answered" : ""
              }`}
              className={cn(
                "relative flex items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors",
                sizeClass(it.timeMs, mode),
                isCurrent && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                // 4.2 — calm "not yet visited" cue: a quiet inset hairline ring
                // instead of a perpetual pulse. Suppressed on the current cell so
                // it doesn't fight the primary focus ring.
                !it.answered && !it.flagged && !isCurrent && "ring-1 ring-inset ring-foreground/15",
                it.flagged
                  ? "bg-warning text-warning-foreground"
                  : typeFill
                    ? "text-white"
                    : it.answered
                      ? "bg-primary/80 text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/70",
              )}
              style={
                typeFill && !it.flagged
                  ? { backgroundColor: dot }
                  : undefined
              }
            >
              {i + 1}
              {/* Eliminated-progress marker (small corner tick). */}
              {it.hasEliminations && !it.flagged && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-destructive"
                />
              )}
              {/* Type-color dot along the bottom edge. */}
              {dot && (
                <span
                  aria-hidden
                  className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
                  style={{ backgroundColor: dot }}
                />
              )}
            </button>

            {hover === i && (
              <div className="absolute bottom-full left-1/2 z-20 mb-1.5 w-52 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-e3">
                <div className="flex items-center gap-1.5 font-medium">
                  {dot && (
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: dot }}
                    />
                  )}
                  Q{i + 1}
                  {it.qType && (
                    <span className="text-muted-foreground">· {qTypeLabel(it.qType)}</span>
                  )}
                </div>
                {it.previewText && (
                  <p className="mt-1 line-clamp-2 text-left text-[10px] leading-snug text-muted-foreground">
                    {it.previewText}
                  </p>
                )}
                <div className="mt-0.5 flex items-center gap-2 text-muted-foreground">
                  <span>{it.answered ? "Answered" : "Unanswered"}</span>
                  {it.flagged && <span className="text-warning">Flagged</span>}
                  {it.timeMs > 0 && (
                    <span className="tabular-nums">{formatMs(it.timeMs)}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A2.2 — memoized. `items` (the per-question NavItem[]) is `useMemo`-stable in
 * SectionRunner and only changes when answers/flags/eliminations/time-on-question
 * change; `onJump` is `useCallback`-stable. So footer renders driven by unrelated
 * state (reading prefs, focus mode, active highlighter) skip the whole strip.
 */
export const NavigatorStrip = memo(NavigatorStripImpl);
