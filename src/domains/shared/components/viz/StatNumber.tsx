import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn, VIZ_TOKENS } from './chart-kit';

/**
 * ANL-5 — host-styled StatNumber, promoted from the LSAT viz barrel.
 *
 * Big tabular number with a count-up on mount and an optional delta chip,
 * restyled onto the host tokens (no `@lsat` motion/util imports). Respects
 * `prefers-reduced-motion` by snapping to the final value.
 */

export interface StatNumberProps {
  value: number | null | undefined;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Optional delta chip (▲/▼ + value), colored by sign. */
  delta?: number | null;
  deltaSuffix?: string;
  label?: ReactNode;
  className?: string;
  /** stat (~2rem) or stat-xl (~2.75rem). */
  size?: 'stat' | 'stat-xl';
  /** Render the figure in the host mono voice (`var(--font-mono)`). */
  voice?: 'sans' | 'numeric';
  /** Short supporting line beneath the figure. */
  subline?: ReactNode;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function StatNumber({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  delta,
  deltaSuffix = '',
  label,
  className,
  size = 'stat',
  voice = 'sans',
  subline,
}: StatNumberProps) {
  const reduce = prefersReducedMotion();
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const numericValue = hasValue ? (value as number) : 0;
  const [display, setDisplay] = useState(reduce ? numericValue : 0);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!hasValue) {
      setDisplay(0);
      return;
    }
    if (reduce) {
      setDisplay(numericValue);
      return;
    }
    const start = performance.now();
    const dur = 320; // host --duration-slow
    const from = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      setDisplay(from + (numericValue - from) * easeOutCubic(p));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [hasValue, numericValue, reduce]);

  const formatted = hasValue
    ? display.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : 'n/a';

  const deltaValue = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
  const hasDelta = deltaValue !== 0;
  const up = deltaValue > 0;

  return (
    <div className={cn('qv-stack-1', className)}>
      {label && (
        <span style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: VIZ_TOKENS.textMuted }}>
          {label}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          className="tabular-nums"
          style={{
            lineHeight: 1,
            fontWeight: 600,
            fontFamily: voice === 'numeric' ? 'var(--font-mono)' : 'var(--font-sans)',
            fontSize: size === 'stat' ? 'var(--fs-3xl)' : 'var(--fs-4xl)',
            color: VIZ_TOKENS.text,
          }}
        >
          {prefix}
          {formatted}
          {suffix}
        </span>
        {hasDelta && (
          <span
            className="tabular-nums"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              borderRadius: 'var(--radius-full)',
              padding: '2px 6px',
              fontSize: 'var(--fs-xs)',
              fontWeight: 600,
              color: up ? VIZ_TOKENS.success : VIZ_TOKENS.danger,
              background: up ? 'var(--surface-soft, rgba(52,211,153,0.12))' : 'rgba(248,113,113,0.12)',
            }}
          >
            {up ? <TrendingUp size={12} aria-hidden /> : <TrendingDown size={12} aria-hidden />}
            {Math.abs(deltaValue).toLocaleString(undefined, {
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
            })}
            {deltaSuffix}
          </span>
        )}
      </div>
      {subline && (
        <p style={{ marginTop: 4, maxWidth: '60ch', fontSize: 'var(--fs-sm)', color: VIZ_TOKENS.textMuted }}>{subline}</p>
      )}
    </div>
  );
}
