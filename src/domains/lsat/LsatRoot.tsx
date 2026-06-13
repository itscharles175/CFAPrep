/**
 * StudyVault mount point for the vendored LSAT Lab app.
 *
 * The LSAT frontend is a complete standalone SPA (its own AppShell, command
 * palette, theme/mode/motion providers, and router with absolute paths). To
 * embed it natively under `/lsat` without rewriting all of its routes, we run
 * it as a self-contained sub-app behind its OWN `<BrowserRouter basename="/lsat">`.
 *
 * The host (src/main.jsx) branches at the top level: when the URL is under
 * `/lsat`, it mounts THIS component instead of the host app, so only ever one
 * BrowserRouter is live (no nested-router conflict). Switching domains is a
 * hard navigation (window.location), giving a clean state boundary between the
 * two large apps while sharing one window + one bundle (no iframe).
 *
 * Adapted from the original LSAT `main.tsx`: same provider tree + startup
 * side-effects, minus the `createRoot` call (the host owns the root + StrictMode).
 */
import { useEffect, useRef } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiValidationError } from "@lsat/lib/apiSchemas";
import { ThemeProvider } from "@lsat/components/theme-provider";
import { ModeProvider } from "@lsat/components/mode-provider";
import { MotionProvider } from "@lsat/components/motion-provider";
import { TooltipProvider } from "@lsat/components/ui/tooltip";
import App from "@lsat/App";
import { applyDensity, applyHighContrast, applyMeasureCh } from "@lsat/lib/prefs";
import { startAutoFlush } from "@lsat/lib/offlineQueue";
import "@lsat/index.css";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          !(error instanceof ApiValidationError) && failureCount < 1,
        refetchOnWindowFocus: false,
        throwOnError: (error) => error instanceof ApiValidationError,
      },
    },
  });
}

export default function LsatRoot() {
  // One client for the lifetime of the LSAT branch.
  const clientRef = useRef<QueryClient | null>(null);
  if (clientRef.current === null) clientRef.current = makeQueryClient();

  useEffect(() => {
    // Startup side-effects from the original main.tsx (run once on mount).
    applyDensity();
    applyHighContrast();
    applyMeasureCh();

    // Windows 11 Mica/vibrancy opt-in, Tauri-gated + best-effort.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<boolean>("mica_active"))
        .then((on) => {
          if (on) document.documentElement.classList.add("mica");
        })
        .catch(() => {});
    }

    // Pause the hero aurora's infinite animation while the window is hidden.
    const syncIdle = () =>
      document.documentElement.classList.toggle("is-idle", document.hidden);
    document.addEventListener("visibilitychange", syncIdle);
    syncIdle();

    // Drain queued offline writes on reconnect + a slow periodic tick.
    startAutoFlush();

    return () => document.removeEventListener("visibilitychange", syncIdle);
  }, []);

  return (
    <QueryClientProvider client={clientRef.current}>
      <ThemeProvider>
        <ModeProvider>
          <MotionProvider>
            <TooltipProvider delayDuration={200}>
              <BrowserRouter basename="/lsat">
                <App />
              </BrowserRouter>
            </TooltipProvider>
          </MotionProvider>
        </ModeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
