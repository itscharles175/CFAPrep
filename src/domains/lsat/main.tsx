import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiValidationError } from "@/lib/apiSchemas";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeProvider } from "@/components/mode-provider";
import { MotionProvider } from "@/components/motion-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { applyDensity, applyHighContrast, applyMeasureCh } from "@/lib/prefs";
import { startAutoFlush } from "@/lib/offlineQueue";
import "./index.css";

applyDensity();
applyHighContrast();
applyMeasureCh();

// R9 F1.1 — when native Mica/vibrancy is confirmed active (Windows 11 only),
// tag <html> so the chrome opts into translucency (see `.mica` rules in
// index.css). Tauri-gated + best-effort: the web build and non-Mica platforms
// (Windows 10, Linux) never get the class, so they keep opaque rendering.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("mica_active"))
    .then((on) => {
      if (on) document.documentElement.classList.add("mica");
    })
    .catch(() => {});
}

// R10 A3.1 — pause the hero aurora's infinite breath while the window is hidden
// (a study app sits backgrounded for long stretches; no reason to keep a
// compositor animation looping). The `.is-idle` class gates `.aurora-breathe`.
if (typeof document !== "undefined") {
  const syncIdle = () =>
    document.documentElement.classList.toggle("is-idle", document.hidden);
  document.addEventListener("visibilitychange", syncIdle);
  syncIdle();
}

// 5.2 — drain queued offline writes on reconnect + a slow periodic tick so the
// crash-safe loop syncs without requiring the manual "Sync now" button.
startAutoFlush();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A genuine connectivity failure is already absorbed into a sample-data
      // fallback by `withFallback` (lib/hooks.ts), so a query only ever reaches
      // an error state on a real HTTP 4xx/5xx or a contract-drift
      // `ApiValidationError`. Neither is fixed by retrying a malformed/erroring
      // response, so don't retry validation errors.
      retry: (failureCount, error) =>
        !(error instanceof ApiValidationError) && failureCount < 1,
      refetchOnWindowFocus: false,
      // 5.1 — a backend contract drift (zod parse failure at the api boundary)
      // is a developer-facing bug, not a transient/offline condition: throw it
      // to the nearest ErrorBoundary instead of letting a malformed payload sit
      // silently in the query's error state. Ordinary HTTP errors stay in
      // `isError` so pages keep their inline ErrorState + retry affordance.
      throwOnError: (error) => error instanceof ApiValidationError,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("LSAT Lab: #root element missing — index.html may be malformed");
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ModeProvider>
          <MotionProvider>
            <TooltipProvider delayDuration={200}>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </TooltipProvider>
          </MotionProvider>
        </ModeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
