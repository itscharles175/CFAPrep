import { useEffect, useRef, useState } from 'react';
import { getStorage } from '../../lib/storage';

const DISMISS_KEY = 'pwa-install-dismissed';

// PWA `beforeinstallprompt` is not in the standard lib DOM typings — declare
// the minimum shape we actually use so we can avoid `any`.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export function PwaInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const eventRef = useRef<BeforeInstallPromptEvent | null>(null);
  // Keep a stable ref to the handler so we can remove the exact same function.
  const handlerRef = useRef<((event: Event) => void) | null>(null);

  useEffect(() => {
    let alive = true;

    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      eventRef.current = e as BeforeInstallPromptEvent;
      if (alive) setVisible(true);
    }

    getStorage().settings.get(DISMISS_KEY).then((row) => {
      if (!alive || row?.value) return;
      handlerRef.current = handleBeforeInstallPrompt;
      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    });

    return () => {
      alive = false;
      if (handlerRef.current) {
        window.removeEventListener('beforeinstallprompt', handlerRef.current);
        handlerRef.current = null;
      }
    };
  }, []);

  async function handleInstall() {
    const promptEvent = eventRef.current;
    if (!promptEvent) return;
    setVisible(false);
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'dismissed') {
      await getStorage().settings.put({ key: DISMISS_KEY, value: true, updatedAt: new Date().toISOString() });
    }
    eventRef.current = null;
  }

  async function handleDismiss() {
    setVisible(false);
    eventRef.current = null;
    await getStorage().settings.put({ key: DISMISS_KEY, value: true, updatedAt: new Date().toISOString() });
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Install QuantVault"
      style={{
        position: 'fixed',
        bottom: 'var(--space-5, 1.25rem)',
        right: 'var(--space-5, 1.25rem)',
        zIndex: 9999,
        maxWidth: '22rem',
        width: 'calc(100vw - 2rem)',
        background: 'var(--surface-1, #fff)',
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 'var(--radius-lg, 0.75rem)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
        padding: 'var(--space-4, 1rem)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3, 0.75rem)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-2, 0.5rem)',
        }}
      >
        <strong style={{ fontSize: 'var(--fs-sm, 0.875rem)', lineHeight: 1.4 }}>
          Install QuantVault
        </strong>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Dismiss install prompt"
          onClick={handleDismiss}
          style={{ padding: '0 var(--space-1, 0.25rem)', lineHeight: 1, minWidth: 0 }}
        >
          ✕
        </button>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 'var(--fs-xs, 0.75rem)',
          color: 'var(--text-muted, #64748b)',
          lineHeight: 1.5,
        }}
      >
        Add to your home screen for offline-first access and faster launches.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2, 0.5rem)',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleDismiss}
          style={{ fontSize: 'var(--fs-xs, 0.75rem)' }}
        >
          Not now
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleInstall}
          style={{ fontSize: 'var(--fs-xs, 0.75rem)' }}
        >
          Install
        </button>
      </div>
    </div>
  );
}
