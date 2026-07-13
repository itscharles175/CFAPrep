import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Check, Loader2, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// UB5 — toast polish. The original API (show / success / warning / error /
// info / dismiss) is preserved verbatim; everything below is additive:
//   • dedupe — identical concurrent toasts (same type + title + message)
//     coalesce into one row carrying a count badge instead of stacking.
//   • progress / transition — a `loading` toast that can later resolve to
//     success or error in place, via `toast.update(id, …)` or the handle
//     returned by `toast.loading(…)` / `toast.promise(…)`.
//   • undo — an actionable, auto-expiring toast for destructive operations
//     with a visible countdown bar (`toast.undo(message, onUndo)`).
// ---------------------------------------------------------------------------

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'loading';

export interface ToastAction {
  label: string;
  onClick?: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

export interface ToastShowInput extends ToastOptions {
  title?: ReactNode;
  message?: ReactNode;
  type?: ToastType;
}

/** Fields that may be patched onto an existing toast via `update`. */
export interface ToastUpdateInput extends ToastOptions {
  title?: ReactNode;
  message?: ReactNode;
  type?: ToastType;
}

export interface ToastUndoOptions {
  /** How long the undo window stays open before auto-dismissing. */
  duration?: number;
  /** Label for the undo button (defaults to "Undo"). */
  actionLabel?: string;
  title?: ReactNode;
}

export interface ToastPromiseMessages<T> {
  loading: { title?: ReactNode; message?: ReactNode };
  success:
    | { title?: ReactNode; message?: ReactNode }
    | ((value: T) => { title?: ReactNode; message?: ReactNode });
  error:
    | { title?: ReactNode; message?: ReactNode }
    | ((error: unknown) => { title?: ReactNode; message?: ReactNode });
  /** How long the resolved (success/error) toast lingers. Default 4000ms. */
  duration?: number;
}

interface ToastRow {
  id: number;
  title?: ReactNode;
  message?: ReactNode;
  type: ToastType;
  action?: ToastAction;
  exiting: boolean;
  /** Number of coalesced identical toasts (>=1). */
  count: number;
  /** Total window (ms) used to size the countdown bar; 0 = no bar. */
  duration: number;
  /** Stable key used to coalesce identical toasts. */
  dedupeKey?: string;
  /** Wall-clock ms when the auto-dismiss timer was (re)armed. */
  startedAt: number;
}

export interface ToastApi {
  show: (input: ToastShowInput) => number;
  success: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  warning: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  error: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  info: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  /** A sticky "in progress" toast. Resolve it with `update` or the helpers. */
  loading: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  /** Patch an existing toast in place (e.g. loading → success). */
  update: (id: number, patch: ToastUpdateInput) => void;
  /** Destructive-action toast with an undo callback + visible countdown. */
  undo: (message: ReactNode, onUndo: () => void, opts?: ToastUndoOptions) => number;
  /** Drive a loading→success/error toast from a promise. */
  promise: <T>(promise: Promise<T>, messages: ToastPromiseMessages<T>) => Promise<T>;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let toastId = 0;

const EXIT_MS = 200;

/** Stable identity for coalescing: type + serialised title/message. */
function dedupeKeyFor(type: ToastType, title?: ReactNode, message?: ReactNode): string | undefined {
  const titleKey = typeof title === 'string' || typeof title === 'number' ? String(title) : null;
  const messageKey =
    typeof message === 'string' || typeof message === 'number' ? String(message) : null;
  // Only coalesce toasts whose content is plain text — arbitrary ReactNodes
  // can't be compared reliably, so they always get their own row.
  if (titleKey === null && messageKey === null) return undefined;
  return `${type}::${titleKey ?? ''}::${messageKey ?? ''}`;
}

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRow[]>([]);
  const timers = useRef<Map<string | number, ReturnType<typeof setTimeout>>>(new Map());
  // Mirror of `toasts` for stable callbacks (dedupe / update lookups) that must
  // read the latest rows without being recreated on every toast change.
  const toastsRef = useRef<ToastRow[]>(toasts);
  toastsRef.current = toasts;

  const clearTimer = useCallback((key: string | number) => {
    const timer = timers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(key);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timers.current.delete(`exit-${id}`);
      }, EXIT_MS);
      timers.current.set(`exit-${id}`, timer);
    },
    [clearTimer],
  );

  const arm = useCallback(
    (id: number, duration: number) => {
      clearTimer(id);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
    },
    [clearTimer, dismiss],
  );

  const addToast = useCallback(
    ({ title, message, type = 'info', duration, action }: ToastShowInput): number => {
      // `loading` toasts are sticky by default (duration 0); others 4000ms.
      const resolvedDuration = duration ?? (type === 'loading' ? 0 : 4000);
      const key = dedupeKeyFor(type, title, message);

      // Coalesce against an existing, non-exiting twin (skip actionable toasts —
      // an undo/action toast is unique and must keep its own callback).
      if (key && !action) {
        const existing = toastsRef.current.find(
          (t) => t.dedupeKey === key && !t.exiting && !t.action,
        );
        if (existing) {
          setToasts((prev) =>
            prev.map((t) =>
              t.id === existing.id
                ? { ...t, count: t.count + 1, startedAt: Date.now(), duration: resolvedDuration }
                : t,
            ),
          );
          arm(existing.id, resolvedDuration);
          return existing.id;
        }
      }

      const id = ++toastId;
      setToasts((prev) => [
        ...prev,
        {
          id,
          title,
          message,
          type,
          action,
          exiting: false,
          count: 1,
          duration: resolvedDuration,
          dedupeKey: key,
          startedAt: Date.now(),
        },
      ]);
      arm(id, resolvedDuration);
      return id;
    },
    [arm],
  );

  const update = useCallback(
    (id: number, patch: ToastUpdateInput) => {
      setToasts((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const type = patch.type ?? t.type;
          const title = 'title' in patch ? patch.title : t.title;
          const message = 'message' in patch ? patch.message : t.message;
          const resolvedDuration =
            patch.duration ?? (type === 'loading' ? 0 : 4000);
          return {
            ...t,
            type,
            title,
            message,
            action: 'action' in patch ? patch.action : t.action,
            duration: resolvedDuration,
            dedupeKey: dedupeKeyFor(type, title, message),
            startedAt: Date.now(),
            exiting: false,
          };
        }),
      );
      // Re-arm the auto-dismiss for the (possibly newly time-boxed) toast.
      const next = patch.type ?? toastsRef.current.find((t) => t.id === id)?.type ?? 'info';
      const resolvedDuration = patch.duration ?? (next === 'loading' ? 0 : 4000);
      arm(id, resolvedDuration);
    },
    [arm],
  );

  const undo = useCallback(
    (message: ReactNode, onUndo: () => void, opts?: ToastUndoOptions): number => {
      const duration = opts?.duration ?? 6000;
      return addToast({
        title: opts?.title,
        message,
        type: 'info',
        duration,
        action: { label: opts?.actionLabel ?? 'Undo', onClick: onUndo },
      });
    },
    [addToast],
  );

  const promise = useCallback(
    <T,>(p: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> => {
      const id = addToast({
        type: 'loading',
        title: messages.loading.title,
        message: messages.loading.message,
        duration: 0,
      });
      const settleDuration = messages.duration ?? 4000;
      return p.then(
        (value) => {
          const resolved =
            typeof messages.success === 'function' ? messages.success(value) : messages.success;
          update(id, { type: 'success', ...resolved, duration: settleDuration });
          return value;
        },
        (err) => {
          const resolved =
            typeof messages.error === 'function' ? messages.error(err) : messages.error;
          update(id, { type: 'error', ...resolved, duration: settleDuration });
          throw err;
        },
      );
    },
    [addToast, update],
  );

  const toast = useMemo<ToastApi>(
    () => ({
      show: addToast,
      success: (title, message, opts) => addToast({ title, message, type: 'success', ...opts }),
      warning: (title, message, opts) => addToast({ title, message, type: 'warning', ...opts }),
      error: (title, message, opts) => addToast({ title, message, type: 'error', ...opts }),
      info: (title, message, opts) => addToast({ title, message, type: 'info', ...opts }),
      loading: (title, message, opts) => addToast({ title, message, type: 'loading', ...opts }),
      update,
      undo,
      promise,
      dismiss,
    }),
    [addToast, update, undo, promise, dismiss],
  );

  // Tear down every pending timer when the provider unmounts.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

interface ToastItemProps {
  toast: ToastRow;
  onDismiss: (id: number) => void;
}

function ToastItem({ toast: t, onDismiss }: ToastItemProps) {
  // The countdown bar (undo + auto-dismiss) animates from full → empty over the
  // toast's own duration. We flip width from 100% → 0% one frame after mount so
  // the CSS transition runs; reduced-motion users just see it sit at 100%.
  const [barWidth, setBarWidth] = useState('100%');
  const showBar = t.duration > 0 && !t.exiting && t.type !== 'loading';

  useEffect(() => {
    if (!showBar) {
      setBarWidth('100%');
      return;
    }
    setBarWidth('100%');
    const raf = requestAnimationFrame(() => setBarWidth('0%'));
    return () => cancelAnimationFrame(raf);
    // Re-run when the timer is re-armed (startedAt changes) or duration changes.
  }, [showBar, t.startedAt, t.duration]);

  const barStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 2,
    width: barWidth,
    background: 'var(--accent)',
    borderBottomLeftRadius: 'var(--radius-md)',
    transition: `width ${t.duration}ms linear`,
  };

  return (
    <div
      className={`toast toast-${t.type} ${t.exiting ? 'toast-exit' : ''}`}
      role="alert"
      style={{ position: 'relative', overflow: 'hidden' }}
    >
      {t.type === 'loading' && (
        <Loader2
          size={16}
          aria-hidden="true"
          // `pulse` is a global host keyframe; the global prefers-reduced-motion
          // guard in index.css forces it to ~0 duration for motion-sensitive users.
          style={{ flexShrink: 0, color: 'var(--accent)', animation: 'pulse 1.4s ease-in-out infinite' }}
        />
      )}
      {t.type === 'success' && (
        <Check size={16} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--success)' }} />
      )}
      <div className="toast-body">
        {t.title && (
          <div className="toast-title">
            {t.title}
            {t.count > 1 && (
              <span
                className="toast-count"
                aria-label={`${t.count} occurrences`}
                style={{
                  marginLeft: 'var(--space-2)',
                  padding: '0 var(--space-2)',
                  borderRadius: '999px',
                  background: 'var(--bg-tertiary, var(--border))',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--fs-xs)',
                  fontWeight: 600,
                }}
              >
                ×{t.count}
              </span>
            )}
          </div>
        )}
        {t.message && <div className="toast-message">{t.message}</div>}
      </div>
      {t.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            t.action?.onClick?.();
            onDismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-dismiss"
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
      {showBar && <div aria-hidden="true" style={barStyle} />}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside ToastProvider');
  }
  return context;
}
