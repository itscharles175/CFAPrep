import { useEffect } from "react";
import { m, useReducedMotion } from "motion/react";
import { Lock } from "lucide-react";
import { Logo } from "@/components/logo";
import { LiveRegion } from "@/components/question/live-region";
import { duration as motionDuration, easing } from "@/lib/motion";

/**
 * R9 (docs/19 "section-complete 'sealed' beat").
 *
 * A brief closure animation shown the instant a section is finished, BEFORE the
 * break/done ceremony — the answers are committed and the section is "sealed."
 * Deliberately shows NO score, answers, or correctness (Test-Mode integrity: the
 * exam reveals nothing until blind review). It is a pure transitional moment: a
 * ring draws closed around a lock over the brand mark, then `onDone` advances.
 *
 * Reduced-motion skips straight to `onDone` after a short beat (no draw), and the
 * `aria-live` line states only "Section sealed" — never a result.
 */
export function SealedBeat({
  label,
  onDone,
  duration = 1500,
}: {
  /** e.g. "Section 2 sealed". */
  label: string;
  onDone: () => void;
  duration?: number;
}) {
  const reduce = useReducedMotion();

  useEffect(() => {
    const ms = reduce ? 650 : duration;
    const t = window.setTimeout(onDone, ms);
    return () => window.clearTimeout(t);
  }, [onDone, duration, reduce]);

  const size = 132;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
      <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden className="absolute inset-0">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={stroke}
          />
          <m.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            initial={{ strokeDashoffset: reduce ? 0 : c }}
            animate={{ strokeDashoffset: 0 }}
            // Bespoke ceremonial draw length (no scale token); tokenized ease.
            transition={{ duration: reduce ? 0 : 0.9, ease: easing.emphasized }}
          />
        </svg>
        <m.span
          className="relative inline-flex items-center justify-center"
          initial={reduce ? false : { scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: motionDuration.slow, delay: reduce ? 0 : 0.5, ease: easing.emphasized }}
        >
          <Logo className="h-9 w-9 opacity-90" />
          <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Lock className="h-3 w-3" strokeWidth={2.2} />
          </span>
        </m.span>
      </div>
      <m.p
        className="type-display mt-6 text-xl"
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: motionDuration.slow, delay: reduce ? 0 : 0.7, ease: easing.emphasized }}
      >
        {label}
      </m.p>
      <p className="type-counsel mt-1 text-sm text-muted-foreground">
        Your answers are committed.
      </p>
      <LiveRegion message="Section sealed" assertive />
    </div>
  );
}
