import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Copy, Minus, Square, X } from "lucide-react";
import { Logo } from "@lsat/components/logo";
import { Icon } from "@lsat/components/ui/icon";
import { routeCommandLabel } from "@lsat/lib/commandRecents";
import { cn } from "@lsat/lib/utils";

/**
 * Runtime Tauri detection. Tauri v2 injects `__TAURI_INTERNALS__` onto `window`.
 * In a plain browser (Vite dev / web build) this is absent, so we render nothing
 * and the web build is completely unaffected.
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface WinControls {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
}

/**
 * Lazily import `@tauri-apps/api/window` only under Tauri. We keep the import
 * dynamic so the web bundle never needs the module at load time.
 */
async function loadWindowControls(): Promise<WinControls | null> {
  if (!isTauri()) return null;
  try {
    const mod = await import("@tauri-apps/api/window");
    const win = mod.getCurrentWindow();
    return {
      minimize: () => void win.minimize(),
      toggleMaximize: () => void win.toggleMaximize(),
      close: () => void win.close(),
      isMaximized: () => win.isMaximized(),
      onResized: (cb) => win.onResized(cb),
    };
  } catch {
    return null;
  }
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-12 items-center justify-center text-muted-foreground transition-colors",
        "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        danger
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-accent/80",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Custom desktop titlebar with a drag region + window controls (§2.11).
 * Renders ONLY under Tauri; returns null in a browser so the web build is intact.
 *
 * W8 — window size/position/maximized are persisted and restored **natively**
 * by `tauri-plugin-window-state` (registered in `src-tauri/src/lib.rs`). The old
 * JS localStorage shim (and its resize-on-show flash) has been removed; this
 * component now only renders the chrome and tracks the maximized flag so the
 * maximize/restore button shows the right icon.
 *
 * R9 (docs/19 F1.1 + F5): the bar uses `.chrome-glass` (solid by default; frosts
 * under native Mica on Win11) instead of `bg-card`, and carries a centered
 * window title so the desktop frame reads as one unit — the AppShell top header
 * sheds its redundant title in favor of this. `title` defaults to the brand
 * wordmark; full-bleed windows (the passage pop-out) pass their own.
 */
export function Titlebar({ title }: { title?: string } = {}) {
  const [controls, setControls] = useState<WinControls | null>(null);
  const [maximized, setMaximized] = useState(false);
  const { pathname } = useLocation();

  // The centered title tracks the route (e.g. "PrepTests", "Analytics"); the
  // dashboard/root and immersive full-bleed exam windows fall back to the brand
  // name so the bar never reads as a confusing breadcrumb mid-section. The
  // passage pop-out (its own window) gets a window-specific label.
  const immersive =
    pathname.startsWith("/take/") ||
    pathname.startsWith("/exam/") ||
    pathname.startsWith("/blind-review/");
  let routeTitle: string;
  if (pathname.startsWith("/popout/passage")) routeTitle = "Passage — LSAT Lab";
  else if (pathname === "/" || immersive) routeTitle = "LSAT Lab";
  else routeTitle = routeCommandLabel(pathname);
  const centerTitle = title ?? routeTitle;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    loadWindowControls().then((c) => {
      if (cancelled || !c) return;
      setControls(c);
      c.onResized(() => void c.isMaximized().then(setMaximized)).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
      void c.isMaximized().then(setMaximized);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Not under Tauri (or controls failed to load): render nothing.
  if (!isTauri() || !controls) return null;

  return (
    <div
      data-tauri-drag-region
      className="titlebar chrome-glass relative flex h-8 w-full shrink-0 select-none items-center justify-between border-b pl-3 text-xs"
    >
      {/* Brand lockup (left) */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 font-medium text-muted-foreground"
      >
        <Logo className="h-3.5 w-3.5" />
        <span data-tauri-drag-region className="tracking-tight">
          LSAT&nbsp;Lab
        </span>
      </div>
      {/* Centered window title — absolutely centered so it tracks the window,
          not the asymmetric brand/controls. Draggable; truncates gracefully. */}
      <span
        data-tauri-drag-region
        className="pointer-events-none absolute left-1/2 max-w-[40%] -translate-x-1/2 truncate text-center font-medium text-muted-foreground/90"
      >
        {centerTitle}
      </span>
      {/* Window controls (right) */}
      <div className="flex items-center">
        <ControlButton label="Minimize window" onClick={controls.minimize}>
          <Icon as={Minus} size="xs" />
        </ControlButton>
        <ControlButton
          label={maximized ? "Restore window" : "Maximize window"}
          onClick={controls.toggleMaximize}
        >
          {maximized ? (
            <Copy className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
          ) : (
            <Square className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
          )}
        </ControlButton>
        <ControlButton label="Close window" onClick={controls.close} danger>
          <Icon as={X} size="xs" />
        </ControlButton>
      </div>
    </div>
  );
}
