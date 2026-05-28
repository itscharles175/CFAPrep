import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

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

interface ToastRow {
  id: number;
  title?: ReactNode;
  message?: ReactNode;
  type: ToastType;
  action?: ToastAction;
  exiting: boolean;
}

export interface ToastApi {
  show: (input: ToastShowInput) => number;
  success: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  warning: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  error: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  info: (title?: ReactNode, message?: ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let toastId = 0;

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRow[]>([]);
  const timers = useRef<Map<string | number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, 200);
    timers.current.set(`exit-${id}`, timer);
  }, []);

  const addToast = useCallback(
    ({ title, message, type = 'info', duration = 4000, action }: ToastShowInput): number => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { id, title, message, type, action, exiting: false }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const toast = useMemo<ToastApi>(
    () => ({
      show: addToast,
      success: (title, message, opts) => addToast({ title, message, type: 'success', ...opts }),
      warning: (title, message, opts) => addToast({ title, message, type: 'warning', ...opts }),
      error: (title, message, opts) => addToast({ title, message, type: 'error', ...opts }),
      info: (title, message, opts) => addToast({ title, message, type: 'info', ...opts }),
      dismiss,
    }),
    [addToast, dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type} ${t.exiting ? 'toast-exit' : ''}`}
            role="alert"
          >
            <div className="toast-body">
              {t.title && <div className="toast-title">{t.title}</div>}
              {t.message && <div className="toast-message">{t.message}</div>}
            </div>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action?.onClick?.();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
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
