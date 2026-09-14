import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { useReducedMotion } from "@/lib/reducedMotion";

/**
 * R9 (docs/19 F7) — navigation-driven top progress bar.
 *
 * The old version ran a *fixed* 480ms fake timeline on every `pathname` change,
 * so it finished while a slow lazy chunk was still downloading (lying), and
 * blinked even for instant in-memory navigations. This version is tied to real
 * work:
 *   - Lazy-route `Suspense` fallbacks mount `<SuspenseSignal/>`, which `begin()`s
 *     on mount and `end()`s on unmount — so the bar is visible for *exactly* as
 *     long as a route chunk / data boundary is actually suspended, then completes
 *     when the real screen commits.
 *   - A `pathname` change also nudges it (a brief acknowledgment) for already-
 *     cached routes that never suspend, so taps still feel responsive.
 *
 * While pending it eases toward — but never reaches — 90% (it cannot know true
 * progress); on completion it snaps to 100% and fades. Reduced motion is honored
 * by the global CSS net (transition-duration collapses), so it simply appears/
 * disappears for users who ask.
 */

interface LoadingBarApi {
  /** Mark one unit of navigation work as started. */
  begin: () => void;
  /** Mark one unit of navigation work as finished. */
  end: () => void;
}

const LoadingBarCtx = createContext<LoadingBarApi | null>(null);

/**
 * Drop this inside a `Suspense fallback` to drive the global bar from real
 * suspense state. It renders nothing of its own; the visible fallback is the
 * route skeleton it sits beside. No-op (renders null) outside the provider so
 * it's always safe to mount.
 */
export function SuspenseSignal() {
  const api = useContext(LoadingBarCtx);
  useEffect(() => {
    if (!api) return;
    api.begin();
    return () => api.end();
  }, [api]);
  return null;
}

export function GlobalLoadingBar({ children }: { children?: React.ReactNode }) {
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);

  // How many suspense boundaries / navigation acks are currently in flight.
  const pending = useRef(0);
  const trickle = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  const clearTrickle = () => {
    if (trickle.current != null) {
      window.clearInterval(trickle.current);
      trickle.current = null;
    }
  };

  const show = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    // The route-shaped skeleton and its polite busy state already communicate
    // loading. Do not add a moving top-bar acknowledgment for reduced-motion
    // users, especially during a timed assessment.
    if (reduce) return;
    setVisible(true);
    // A second navigation can arrive while the previous completion is fading.
    // Restart at an honest in-progress value rather than briefly showing 100%.
    setWidth((w) => (w === 0 || w >= 100 ? 12 : Math.max(12, w)));
    if (trickle.current == null) {
      // Ease toward 90% on a decaying curve; never claim completion.
      trickle.current = window.setInterval(() => {
        setWidth((w) => (w >= 90 ? w : w + Math.max(0.6, (90 - w) * 0.12)));
      }, 120);
    }
  }, [reduce]);

  const finish = useCallback(() => {
    clearTrickle();
    if (reduce) {
      setVisible(false);
      setWidth(0);
      return;
    }
    setWidth(100);
    hideTimer.current = window.setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 140);
  }, [reduce]);

  const begin = useCallback(() => {
    pending.current += 1;
    show();
  }, [show]);

  const end = useCallback(() => {
    pending.current = Math.max(0, pending.current - 1);
    if (pending.current === 0) finish();
  }, [finish]);

  // Already-cached routes never suspend — give them a brief, self-completing
  // acknowledgment so navigation still registers visually. The cleanup balances
  // the count: if the next navigation arrives before the ack times out, end it
  // there so `pending` can never get stranded above zero (which would freeze the
  // bar visible). `acked` guards against double-decrementing.
  useEffect(() => {
    if (reduce) return undefined;
    begin();
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      end();
    };
    const t = window.setTimeout(ack, 120);
    return () => {
      window.clearTimeout(t);
      ack();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, reduce]);

  useEffect(() => {
    if (!reduce) return;
    clearTrickle();
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    setVisible(false);
    setWidth(0);
  }, [reduce]);

  useEffect(
    () => () => {
      clearTrickle();
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // The Suspense fallback needs a stable context value. Recreating it on each
  // trickle frame re-runs SuspenseSignal's effect, which can keep a pending
  // signal alive long after a route has painted.
  const api = useMemo(() => ({ begin, end }), [begin, end]);

  return (
    <LoadingBarCtx.Provider value={api}>
      {visible && (
        <div
          role="progressbar"
          aria-label="Page loading"
          aria-valuenow={Math.round(width)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="lsat-global-loading-bar pointer-events-none fixed left-0 right-0 top-[var(--topbar-height)] z-[var(--z-overlay)] h-0.5 overflow-hidden"
        >
          <div
            className="h-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)] transition-[width] duration-200 ease-out"
            style={{ width: `${width}%` }}
          />
        </div>
      )}
      {children}
    </LoadingBarCtx.Provider>
  );
}
