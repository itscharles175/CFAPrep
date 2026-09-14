import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { ServerOff } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { SystemNotice } from "@lsat/components/system-notice";
import { useAiHealth } from "@lsat/lib/hooks";
import { getOfflineStatus, subscribeOfflineStatus } from "@lsat/lib/offline";
import { isAiPrereqDismissed, setAiPrereqDismissed } from "@lsat/lib/prefs";

// Active local-provider labels, consistent with model-routing-card.tsx.
const PROVIDER_LABEL: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LMStudio",
};

/**
 * S3 — Prerequisite / offline banner. Shown app-wide when live AI is off: the
 * app falls back to sample data, and starting the active local provider enables
 * live AI again. Dismissible and non-blocking; the dismissal persists in
 * localStorage.
 *
 * Provider-agnostic (LMStudio support): the backend reports a generic `ok`
 * (active provider reachable) plus a `provider` ("ollama"|"lmstudio"). "AI is
 * off" therefore means EITHER the backend is unreachable (`usingSample`) OR the
 * active provider is unreachable (`ok === false`, with a back-compat fallback to
 * the legacy `ollama` boolean only when `ok` is absent). The copy names whichever
 * provider is active so the fix-it hint is correct.
 *
 * R9 (docs/19 F4) — speaks the unified {@link SystemNotice} status language
 * instead of a bespoke `Alert`, so app-wide advisories all read alike.
 */
export function AiPrereqBanner() {
  const { data, refetch, isFetching } = useAiHealth();
  const navigate = useNavigate();
  // `withFallback` envelope: `data.usingSample` is true when the health request
  // itself failed (backend unreachable); `data.data` is the AI-health payload.
  const usingSample = data?.usingSample ?? false;
  const h = data?.data;
  const [dismissed, setDismissed] = useState(() => isAiPrereqDismissed());

  // A6 — de-stack the system notices. When the backend is unreachable the
  // <OfflineBanner> already says "Backend offline — showing sample data", which
  // is the same root cause as our `usingSample` branch. Showing both stacks two
  // identical warnings. So suppress ourselves while offline and let OfflineBanner
  // own that case; we remain the ONLY banner for our unique signal — backend UP
  // but the active AI provider down (`providerDown`) — and never double up.
  const { offline } = useSyncExternalStore(
    subscribeOfflineStatus,
    getOfflineStatus,
    () => ({ offline: false, queueDepth: 0 }),
  );

  // Live AI is off when the backend itself is unreachable (sample-data mode) OR
  // the active provider is unreachable. Prefer the generic `ok`; fall back to the
  // legacy `ollama` boolean only on an older backend that omits `ok`.
  const providerDown = h?.ok === false || (h?.ok === undefined && h?.ollama === false);
  const aiOff = usingSample === true || providerDown;
  if (!aiOff || dismissed || offline) return null;

  const provider = h?.provider ?? "ollama";
  const providerLabel = PROVIDER_LABEL[provider] ?? "Ollama";

  function dismiss() {
    setAiPrereqDismissed(true);
    setDismissed(true);
  }

  return (
    <div className="px-4 pt-3 print:hidden">
      <SystemNotice
        tone="warning"
        icon={ServerOff}
        className="lsat-ai-prereq-notice"
        title="Live AI is off — running in sample-data mode"
        action={
          <>
            <Button
              variant="outline"
              onClick={() => void refetch()}
              loading={isFetching}
            >
              Retry
            </Button>
            <Button onClick={() => navigate("/lsat/settings#ai-system")}>
              Open AI settings
            </Button>
          </>
        }
        onDismiss={dismiss}
      >
        {providerLabel} isn’t reachable, so explanations, the coach, and
        generation use built-in sample data.{" "}
        {provider === "lmstudio" ? (
          <>Start your LMStudio server and load a model to enable live AI.</>
        ) : (
          <>
            Start Ollama with the{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">qwen3:8b</code>{" "}
            and{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">qwen3:14b</code>{" "}
            models to enable live AI.
          </>
        )}{" "}
        Everything else keeps working in the meantime.
      </SystemNotice>
    </div>
  );
}
