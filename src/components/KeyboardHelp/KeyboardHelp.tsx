import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Dialog } from '../ui/Primitives';
import { appRoutes } from '../../routes/routeManifest';

/**
 * UB6 — Shared "?" keyboard-help overlay for the host shell.
 *
 * A single self-contained modal that lists the host's global shortcuts plus the
 * keyboard scopes declared for the currently active route in routeManifest. It
 * owns its own open state so any host page gets the same help without threading
 * props through App:
 *
 *   - Pressing "?" (when not typing in an input/textarea/contenteditable, and
 *     without a modifier) toggles it open.
 *   - The TopBar help button dispatches KEYBOARD_HELP_EVENT to open it on click.
 *   - Escape (and a click on the backdrop) closes it — handled by the shared
 *     Dialog primitive, which also provides role="dialog", aria-modal, the
 *     focus trap, labelled/described wiring, and focus restoration on close.
 *
 * The overlay reuses the host `Dialog` (`.confirm-dialog` surface), which has no
 * enter animation and is covered by the global prefers-reduced-motion net, so it
 * is reduced-motion friendly by construction.
 */

/** Custom event the TopBar help button (and any host control) dispatches to open this. */
export const KEYBOARD_HELP_EVENT = 'quantvault:keyboard-help';

interface ShortcutRow {
  keys: string[];
  label: string;
}

const GLOBAL_SHORTCUTS: ShortcutRow[] = [
  { keys: ['Ctrl+K', 'Cmd+K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Open this help dialog' },
  { keys: ['Esc'], label: 'Close dialog or palette' },
  { keys: ['Tab'], label: 'Move focus to the next control' },
  { keys: ['Shift+Tab'], label: 'Move focus to the previous control' },
];

/**
 * Resolve the route definition for a pathname, tolerant of dynamic segments
 * (`/cfa/:level/:topic`) and trailing wildcards. Mirrors the matcher that used
 * to live inline in App so the help dialog surfaces the active page's scopes.
 */
function routeForPath(pathname: string) {
  return (
    appRoutes.find((route) => route.path === pathname) ||
    appRoutes.find((route) => route.path.endsWith('/*') && pathname.startsWith(route.path.slice(0, -2))) ||
    appRoutes.find((route) => {
      const prefix = route.path.split('/:')[0];
      return prefix && prefix !== '/' && pathname.startsWith(prefix);
    })
  );
}

export default function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // `?` toggles the help dialog; skip if the user is typing into a text
      // field or has a modifier held (avoid hijacking question-mark in inputs
      // and leaving Ctrl/Cmd shortcuts alone).
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      setOpen((value) => !value);
    }

    function handleOpenRequest() {
      setOpen(true);
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(KEYBOARD_HELP_EVENT, handleOpenRequest);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(KEYBOARD_HELP_EVENT, handleOpenRequest);
    };
  }, []);

  if (!open) return null;

  const route = routeForPath(location.pathname);
  const routeHelp = route?.keyboardHelp ?? [];

  return (
    <Dialog
      title="Keyboard shortcuts"
      description="Global shortcuts plus this route's scopes. Press Esc or click outside to close."
      onClose={() => setOpen(false)}
      actions={
        <button className="btn btn-primary" onClick={() => setOpen(false)}>
          Got it
        </button>
      }
    >
      <section className="keyboard-help-section">
        <h4 className="keyboard-help-heading">Global</h4>
        <ul className="keyboard-help-list">
          {GLOBAL_SHORTCUTS.map((shortcut) => (
            <li key={shortcut.label} className="keyboard-help-row">
              <span className="keyboard-help-keys">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              <span className="keyboard-help-label">{shortcut.label}</span>
            </li>
          ))}
        </ul>
      </section>
      {route && routeHelp.length > 0 && (
        <section className="keyboard-help-section">
          <h4 className="keyboard-help-heading">This page · {route.navLabel}</h4>
          <ul className="keyboard-help-list">
            {routeHelp.map((entry, index) => (
              <li key={`${entry.scope}-${index}`} className="keyboard-help-row">
                <span className="keyboard-help-keys">
                  {entry.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
                <span className="keyboard-help-label keyboard-help-scope">{entry.label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}
