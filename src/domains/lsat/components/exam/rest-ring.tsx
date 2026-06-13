import { useEffect, useRef, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import { cn, formatClock } from "@/lib/utils";
import { LiveRegion } from "@/components/question/live-region";

/**
 * R9 (docs/19 "the break timer as a designed rest moment").
 *
 * The break is the opposite of the exam clock, so it gets the opposite instrument:
 * not the depleting urgency hairline but a calm ring that *fills* as the rest is
 * banked, wrapped around a slow breathing pulse that paces the exhale. The center
 * reads the remaining clock; on completion the ring closes and the copy turns to
 * "Rested." Reduced-motion stills the breath and the sweep (instant fill).
 *
 * Pre/post-clock surface — no question content, no Test-Mode risk. The remaining
 * time is announced politely at the minute marks via an internal live region so
 * the visual ring is not the only channel.
 */
export function RestRing({
  remaining,
  total,
  size = 168,
  paused = false,
}: {
  /** Seconds left in the break. */
  remaining: number;
  /** Full break length (s); drives the fill fraction. */
  total: number;
  size?: number;
  paused?: boolean;
}) {
  const reduce = useReducedMotion();
  const strokeWidth = 6;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  // Fraction of the break that has been *banked* (so the ring fills up over time).
  const elapsed = total > 0 ? Math.max(0, Math.min(1, (total - remaining) / total)) : 0;
  const done = remaining <= 0 && total > 0;

  // Animate the stroke fill toward the current elapsed fraction.
  const [shown, setShown] = useState(reduce ? elapsed : 0);
  useEffect(() => {
    if (reduce) {
      setShown(elapsed);
      return;
    }
    const id = requestAnimationFrame(() => setShown(elapsed));
    return () => cancelAnimationFrame(id);
  }, [elapsed, reduce]);
  const offset = circumference * (1 - shown);

  // Polite minute-mark announcements (never every tick).
  const prevRef = useRef(remaining);
  const [callout, setCallout] = useState("");
  useEffect(() => {
    const prev = prevRef.current;
    if (done) {
      setCallout("Break over");
    } else {
      for (const mark of [300, 120, 60]) {
        if (prev > mark && remaining <= mark) {
          const min = mark / 60;
          setCallout(`${min} minute${min === 1 ? "" : "s"} of break remaining`);
          break;
        }
      }
    }
    prevRef.current = remaining;
  }, [remaining, done]);

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      {/* Breathing aura behind the ring — paces a calm inhale/exhale; stills on
          reduced-motion or while paused. Decorative. */}
      {!reduce && !paused && !done && (
        <m.span
          aria-hidden
          className="absolute rounded-full bg-primary/10"
          style={{ width: size * 0.7, height: size * 0.7 }}
          animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0.85, 0.5] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      <svg width={size} height={size} className="relative" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: reduce ? undefined : "stroke-dashoffset 0.8s cubic-bezier(0.3,0,0,1)",
          }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "type-numeric text-3xl font-semibold tabular-nums leading-none",
            done ? "text-primary" : "text-foreground",
          )}
        >
          {done ? "Rested" : formatClock(remaining)}
        </span>
        <span className="type-overline mt-1.5 text-muted-foreground">
          {done ? "Ready" : paused ? "Paused" : "Breathe"}
        </span>
      </div>

      <LiveRegion message={callout} />
    </div>
  );
}
