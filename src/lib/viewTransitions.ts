/**
 * UI-1 — View Transitions API layer.
 *
 * A thin, framework-agnostic wrapper over the browser's View Transitions API
 * (`document.startViewTransition`) used for cross-route + shared-element motion.
 * The whole module is a NO-OP / instant fall-through whenever a transition would
 * be wrong or impossible:
 *
 *   - the API is unsupported (older browsers, or `document` absent in SSR/test),
 *   - the user has `prefers-reduced-motion: reduce`, or
 *   - the caller asks to skip it.
 *
 * In every fall-through case the DOM-mutating callback still runs SYNCHRONOUSLY
 * (or its promise is awaited), so navigation never depends on the animation —
 * the motion is pure progressive enhancement. This mirrors the rest of the host
 * (see the `prefers-reduced-motion` damping in src/index.css / tokens.css).
 *
 * Persistence: none — view transitions are ephemeral. The reduced-motion check
 * is read live so a mid-session OS change is honoured without a reload.
 */

/** A DOM mutation to run inside (or, on fall-through, outside) a transition. */
export type ViewTransitionUpdate = () => void | Promise<void>;

export interface ViewTransitionOptions {
  /**
   * Force-skip the transition (run the update instantly). Useful for the first
   * paint, programmatic navigation, or when the caller knows motion is unwanted.
   */
  skip?: boolean;
  /**
   * A short, stable name applied to the root `view-transition-name` for the
   * duration of the transition, so a CSS `::view-transition-group(<name>)` rule
   * can theme this specific transition. Cleared automatically when it settles.
   */
  name?: string;
}

/**
 * The browser's native ViewTransition handle (a structural subset — we only use
 * `finished`). Declared locally so the module type-checks without relying on a
 * particular lib.dom.d.ts version shipping the type.
 */
interface ViewTransitionHandle {
  finished: Promise<void>;
  ready?: Promise<void>;
  updateCallbackDone?: Promise<void>;
  skipTransition?: () => void;
}

type StartViewTransition = (callback: ViewTransitionUpdate) => ViewTransitionHandle;

/** True when the OS/user asks to minimise motion. Read live (not cached). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True when the runtime can actually run a view transition (and motion is OK). */
export function supportsViewTransitions(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof (document as Document & { startViewTransition?: StartViewTransition })
      .startViewTransition === 'function'
  );
}

/**
 * Run `update` inside a view transition when possible; otherwise run it instantly.
 *
 * ALWAYS returns a promise that resolves once the DOM mutation has been applied
 * (and, when a real transition ran, once it has finished) — so callers can await
 * completion uniformly regardless of which path was taken. Any error thrown by
 * `update` propagates; a failure of the transition animation itself never rejects
 * the returned promise beyond what `update` already does (the DOM is still updated).
 */
export async function startViewTransition(
  update: ViewTransitionUpdate,
  options: ViewTransitionOptions = {},
): Promise<void> {
  const canTransition = !options.skip && !prefersReducedMotion() && supportsViewTransitions();

  if (!canTransition) {
    // Fall-through: run the mutation directly so navigation is never blocked on
    // (absent) motion. Await in case it is async.
    await update();
    return;
  }

  const root = document.documentElement;
  const previousName = options.name ? root.style.getPropertyValue('view-transition-name') : '';
  if (options.name) {
    root.style.setProperty('view-transition-name', options.name);
  }

  const start = (document as Document & { startViewTransition: StartViewTransition })
    .startViewTransition;

  try {
    const transition = start(update);
    // `finished` resolves after the animation completes; if the browser rejects
    // it (e.g. an interrupted transition) we still consider the navigation done —
    // the DOM was already updated inside the callback.
    await transition.finished.catch(() => undefined);
  } finally {
    if (options.name) {
      if (previousName) root.style.setProperty('view-transition-name', previousName);
      else root.style.removeProperty('view-transition-name');
    }
  }
}
