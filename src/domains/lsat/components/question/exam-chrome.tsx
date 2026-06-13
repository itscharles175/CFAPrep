import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn, formatClock } from "@lsat/lib/utils";
import { LiveRegion } from "@lsat/components/question/live-region";

// 5.6 — assertive callouts at these remaining-time marks (seconds). We announce
// once as the clock crosses each mark, never every tick.
const TIMER_THRESHOLDS = [300, 120, 60];

/** Build the threshold announcement when `timeLeft` lands on/just past a mark. */
function timerCallout(prev: number, next: number): string | null {
  for (const mark of TIMER_THRESHOLDS) {
    if (prev > mark && next <= mark) {
      const min = mark / 60;
      return `${min} minute${min === 1 ? "" : "s"} remaining`;
    }
  }
  return null;
}

/**
 * Ambient exam timer (docs/06 §4.1, R8 §4.2). An instrument, not an alarm: the
 * clock sits over a thin depleting hairline that quietly warms toward amber as
 * time runs low (a graduated edge, replacing the old badge that hard-flipped to
 * red border + red text under 2:00). The hide toggle is preserved. Exposed to
 * assistive tech via role="timer"; assertive announcements fire only at the
 * 5:00 / 2:00 / 1:00 thresholds so the reader is not spammed every second (5.6).
 */
export function ExamTimer({
  timeLeft,
  totalSec,
  hidden,
  onToggleHidden,
  label,
  announce = false,
}: {
  timeLeft: number;
  /** Section length (s); drives the depleting hairline. Omit for an open clock. */
  totalSec?: number;
  hidden: boolean;
  onToggleHidden: () => void;
  label?: string;
  /** When true, emit threshold callouts to a live region (timed sections). */
  announce?: boolean;
}) {
  // Graduated warmth instead of a binary red flip: calm until the final
  // stretch, then a gentle amber that deepens. We lean on the `warning` token
  // (AA-contrast, theme-aware) rather than `destructive` so it reads as guidance.
  const low = timeLeft <= 300 && !hidden; // ≤5:00 — start warming the edge
  const urgent = timeLeft <= 120 && !hidden; // ≤2:00 — warmest, text picks up tint

  const prevRef = useRef(timeLeft);
  const [callout, setCallout] = useState("");
  useEffect(() => {
    if (announce) {
      const msg = timerCallout(prevRef.current, timeLeft);
      if (msg) setCallout(msg);
    }
    prevRef.current = timeLeft;
  }, [timeLeft, announce]);

  // Remaining fraction for the depleting hairline (0..1). Without a total we
  // keep the rail full so the instrument still reads as calm.
  const remaining =
    totalSec && totalSec > 0 ? Math.max(0, Math.min(1, timeLeft / totalSec)) : 1;

  return (
    <div
      role="timer"
      aria-label={
        hidden
          ? "Section timer hidden"
          : `Time remaining ${formatClock(timeLeft)}`
      }
      className="flex flex-col items-stretch gap-1"
    >
      <div
        className={cn(
          "flex items-center gap-2 px-1 text-sm font-semibold tabular-nums transition-colors",
          urgent ? "text-warning" : "text-foreground",
        )}
      >
        {label && <span className="text-xs font-normal text-muted-foreground">{label}</span>}
        {hidden ? (
          <span className="type-numeric text-muted-foreground">--:--</span>
        ) : (
          <span className="type-numeric">{formatClock(timeLeft)}</span>
        )}
        <button
          type="button"
          onClick={onToggleHidden}
          title={hidden ? "Show timer" : "Hide timer"}
          aria-label={hidden ? "Show timer" : "Hide timer"}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          {hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
      </div>
      {/* Depleting hairline: a thin rail with a fill that shortens as time runs
          down and warms toward amber near the end. Decorative — the role="timer"
          label + threshold callouts carry the accessible information. */}
      <div aria-hidden className="h-px w-full overflow-hidden rounded-full bg-border">
        {!hidden && (
          <div
            className={cn(
              "h-full rounded-full transition-[width,background-color] duration-500",
              urgent ? "bg-warning" : low ? "bg-warning/55" : "bg-foreground/25",
            )}
            style={{ width: `${remaining * 100}%` }}
          />
        )}
      </div>
      {announce && <LiveRegion message={callout} assertive />}
    </div>
  );
}

/**
 * Thin pace bar (docs/06 §4.1). Compares progress (questions done) against an
 * even pace given time elapsed. Shows a subtle "X behind/ahead pace" hint.
 */
export function PaceBar({
  total,
  answered,
  elapsedSec,
  totalSec,
  hidden = false,
}: {
  total: number;
  answered: number;
  elapsedSec: number;
  totalSec: number;
  hidden?: boolean;
}) {
  if (total <= 0 || totalSec <= 0) return null;
  const progress = answered / total; // fraction of work done
  const timeFrac = Math.min(1, elapsedSec / totalSec); // fraction of time used
  // Where an even pace says you should be by now.
  const expected = timeFrac * total;
  const delta = answered - expected; // + ahead, - behind
  const behind = delta < -0.5;
  const ahead = delta > 0.5;
  const hint = behind
    ? `${Math.abs(Math.round(delta))} behind pace`
    : ahead
      ? `${Math.round(delta)} ahead of pace`
      : "on pace";

  // 5.6 — pace category drives a polite announcement; we only speak when the
  // category flips (behind/ahead/on) so the reader is not told the count every
  // second. The visual `aria-hidden` wrapper keeps the live region separate.
  const paceCategory = behind ? "behind" : ahead ? "ahead" : "on";

  return (
    <>
      <div className="flex items-center gap-2" aria-hidden={hidden}>
        <div className="relative h-1.5 w-40 overflow-hidden rounded-full bg-muted">
          {/* Even-pace marker. */}
          <div
            className="absolute top-0 h-full w-px bg-foreground/40"
            style={{ left: `${timeFrac * 100}%` }}
          />
          {/* Actual progress. */}
          <div
            className={cn(
              "h-full rounded-full transition-[width,background-color]",
              behind ? "bg-warning" : ahead ? "bg-success" : "bg-primary",
            )}
            style={{ width: `${Math.min(100, progress * 100)}%` }}
          />
        </div>
        {!hidden && (
          <span
            className={cn(
              "text-xs tabular-nums",
              behind ? "text-warning" : ahead ? "text-success" : "text-muted-foreground",
            )}
          >
            {hint}
          </span>
        )}
      </div>
      {!hidden && <PaceAnnouncer category={paceCategory} hint={hint} />}
    </>
  );
}

/** Announces pace only when the category changes (5.6). */
function PaceAnnouncer({
  category,
  hint,
}: {
  category: "behind" | "ahead" | "on";
  hint: string;
}) {
  const [message, setMessage] = useState("");
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (category === last.current) return;
    last.current = category;
    setMessage(`Pace: ${hint}`);
  }, [category, hint]);
  return <LiveRegion message={message} />;
}

/**
 * Two-pane resizable split with a draggable divider (docs/06 §4.6). `fraction`
 * is the left (passage) column width as 0..1; persisted by the parent.
 */
export function ResizableSplit({
  fraction,
  onChange,
  left,
  right,
  className,
}: {
  fraction: number;
  onChange: (f: number) => void;
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const onMove = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = (clientX - rect.left) / rect.width;
      onChange(Math.min(0.7, Math.max(0.3, f)));
    },
    [onChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => onMove(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
  }, [dragging, onMove]);

  return (
    <div ref={ref} className={cn("flex flex-1 overflow-hidden", className)}>
      <div style={{ flexBasis: `${fraction * 100}%` }} className="min-w-0 overflow-y-auto border-r">
        {left}
      </div>
      {/*
        WAI-ARIA "window splitter" pattern: a focusable role="separator" with
        aria-value* + aria-controls that is operable by keyboard (arrows) and
        pointer (drag). The splitter pattern is the documented exception where a
        separator is intentionally focusable/interactive, so the two jsx-a11y
        rules that assume separators are non-interactive are disabled here only.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize passage and question panes"
        aria-valuemin={30}
        aria-valuemax={70}
        aria-valuenow={Math.round(fraction * 100)}
        title="Drag to resize"
        onMouseDown={() => setDragging(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onChange(Math.max(0.3, fraction - 0.05));
          }
          if (e.key === "ArrowRight") {
            e.preventDefault();
            onChange(Math.min(0.7, fraction + 0.05));
          }
        }}
        // Focusable separator is the splitter pattern's intent (see comment above).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className={cn(
          "group relative w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none",
          dragging && "bg-primary",
        )}
      >
        <span className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">{right}</div>
    </div>
  );
}
