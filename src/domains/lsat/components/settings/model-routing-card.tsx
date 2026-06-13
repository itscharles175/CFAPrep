import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, CircleX, Cpu, RotateCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAiHealth, useObservability, useSettings } from "@/lib/hooks";
import { usePregenerate, useSaveSettings } from "@/lib/mutations";
import { getAiMetrics } from "@/lib/aiMetrics";
import { cn } from "@/lib/utils";

/**
 * The model roles the user can assign. `key` is the /settings patch key written
 * on save; `healthKey` is the field read back from /ai/health (the critic role
 * is saved as `gen_critic_model` but reported as `critic_model`).
 */
const MODEL_ROLES = [
  { key: "explain_model", healthKey: "explain_model", label: "Explain model (Tier A, realtime)" },
  { key: "gen_model", healthKey: "gen_model", label: "Generate model (Tier B, offline/batch)" },
  { key: "diagnose_model", healthKey: "diagnose_model", label: "Diagnose model" },
  { key: "embed_model", healthKey: "embed_model", label: "Embed model" },
  { key: "gen_critic_model", healthKey: "critic_model", label: "Critic model (generation gate)" },
] as const;

const CUSTOM = "__custom__";

const PROVIDER_LABEL: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LMStudio",
};

/** Minimal `http(s)://host…` shape check — enough to reject blank/garbage URLs. */
function isValidLmsUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  return /^https?:\/\/.+/i.test(v);
}

/**
 * Loopback hosts the backend accepts without `LSATLAB_ALLOW_REMOTE_LLM`. The
 * server is the real firewall (it 422s a non-loopback URL); this only lets the
 * UI warn before the round-trip instead of after.
 */
export function isLoopbackLmsUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * R9 (docs/19 F4.2) — the model-routing / AI-system card. Now also lets the user
 * pick the LOCAL inference provider (Ollama or an OpenAI-compatible LMStudio
 * server) and set the LMStudio URL; the choice is persisted via /settings and
 * the realtime/embed/offline-local paths follow it. Cloud offline-gen stays
 * orthogonal (the "Offline generation" row below).
 */
export function ModelRoutingCard() {
  const { data: health } = useAiHealth();
  const h = health?.data;
  const obs = useObservability(); // A13 — trust strip
  const o = obs.data?.data;
  const { data: settings } = useSettings();
  const s = settings?.data?.settings;
  // Two independent save mutations so the provider toggle and the URL save have
  // separate pending/disabled states (each must not block the other).
  const saveProvider = useSaveSettings();
  const saveUrl = useSaveSettings();
  const saveModel = useSaveSettings(); // per-role model assignment
  const pregen = usePregenerate(); // A12 — warm cache
  const aiMetrics = getAiMetrics();
  const qc = useQueryClient();

  const availableModels = h?.models ?? [];
  // Configured model ids the active provider doesn't currently list — these
  // roles will fail at call time until a loaded model is chosen (common right
  // after switching to LMStudio, whose ids differ from Ollama tags).
  const missingModels = h?.missing_models ?? [];

  // Active local provider + reachability (generic fields, with back-compat
  // fallbacks to the older `ollama` boolean for an unchanged backend).
  const activeProvider = h?.provider ?? s?.local_provider ?? "ollama";
  // While a provider switch is in flight, show the clicked option immediately
  // (the optimistic cache update also flips `activeProvider`, but reading the
  // mutation's variables is robust even when the cache is still empty).
  const inFlightProvider = saveProvider.variables?.local_provider;
  const pendingProvider =
    saveProvider.isPending && typeof inFlightProvider === "string"
      ? inFlightProvider
      : null;
  const selectedProvider = pendingProvider ?? activeProvider;
  const providerLabel = PROVIDER_LABEL[selectedProvider] ?? "Ollama";
  const connected = h?.ok ?? h?.ollama ?? false;
  const lmsUrl =
    s?.lmstudio_url ?? h?.lmstudio_url ?? "http://localhost:1234/v1";

  // Editable LMStudio URL: null draft means "follow the server value".
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const urlValue = urlDraft ?? lmsUrl;
  const urlTrimmed = urlValue.trim();
  // Save is enabled only for a valid, changed URL that isn't already saving.
  const canSaveUrl =
    !saveUrl.isPending && isValidLmsUrl(urlValue) && urlTrimmed !== lmsUrl.trim();

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon as={Cpu} size="sm" className="text-primary" />
        <CardTitle className="text-base">Model routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Local inference provider — Ollama or LMStudio. A single-select
            ToggleGroup gives correct radio semantics + roving arrow-key focus
            for free; the segmented look is preserved via the item classes. */}
        <Row label="Local provider">
          <ToggleGroup
            type="single"
            value={selectedProvider}
            onValueChange={(v) => v && saveProvider.mutate({ local_provider: v })}
            disabled={saveProvider.isPending}
            aria-label="Local inference provider"
            className="gap-0 overflow-hidden rounded-md border"
          >
            {(["ollama", "lmstudio"] as const).map((p) => (
              <ToggleGroupItem
                key={p}
                value={p}
                className={cn(
                  "h-auto rounded-none px-3 py-1 text-xs font-medium",
                  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
                )}
              >
                {PROVIDER_LABEL[p]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>

        {/* Active-provider reachability. */}
        <div className="flex items-center justify-between">
          <span>{providerLabel}</span>
          {connected ? (
            <span className="flex items-center gap-1 text-success">
              <Icon as={CircleCheck} size="sm" /> connected
            </span>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <Icon as={CircleX} size="sm" /> not reachable
            </span>
          )}
        </div>

        {/* LMStudio base URL — only when LMStudio is the active provider. */}
        {selectedProvider === "lmstudio" && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground">LMStudio server URL</span>
            <div className="flex items-center gap-2">
              <Input
                value={urlValue}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="http://localhost:1234/v1"
                spellCheck={false}
                className="h-8 text-sm"
                aria-label="LMStudio server URL"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canSaveUrl}
                onClick={() =>
                  saveUrl.mutate(
                    { lmstudio_url: urlTrimmed },
                    // Reset the draft so the field re-follows the server value
                    // after a successful save (no stale draft sticking around).
                    { onSuccess: () => setUrlDraft(null) },
                  )
                }
              >
                {saveUrl.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              OpenAI-compatible endpoint (include the <code>/v1</code> suffix).
            </p>
            {isValidLmsUrl(urlValue) && !isLoopbackLmsUrl(urlValue) && (
              <p className="text-xs text-warning">
                Non-loopback URL — the server only accepts this with{" "}
                <code>LSATLAB_ALLOW_REMOTE_LLM=1</code> (realtime AI sends official
                content, so it stays on-device by default).
              </p>
            )}
          </div>
        )}

        {/* Roles whose configured model id isn't loaded in the active provider
            will fail at call time — surface them so the user can fix it here
            instead of discovering it when an explanation silently fails. */}
        {missingModels.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
            <Icon
              as={AlertTriangle}
              size="sm"
              className="mt-0.5 shrink-0 text-warning"
            />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">
                {missingModels.length} configured model
                {missingModels.length === 1 ? "" : "s"} not loaded in{" "}
                {providerLabel}
              </p>
              <p className="text-muted-foreground">
                {missingModels.join(", ")} — pick a loaded model for each role
                below, or load these in {providerLabel}. AI for those roles will
                fail until then.
              </p>
            </div>
          </div>
        )}

        {/* Editable model-role assignment. A loaded-model dropdown when the
            provider is reachable; a free-text id input when it isn't (so you
            can pre-set ids before starting Ollama/LMStudio). */}
        {MODEL_ROLES.map((role) => {
          const value =
            (h?.[role.healthKey as keyof typeof h] as string | undefined) ?? "";
          return (
            <ModelRolePicker
              key={role.key}
              label={role.label}
              value={value}
              models={availableModels}
              missing={!!value && missingModels.includes(value)}
              pending={saveModel.isPending}
              onSave={(v) => saveModel.mutate({ [role.key]: v })}
            />
          );
        })}
        <Row label="Available models">
          <div className="flex flex-wrap items-center gap-1">
            {availableModels.map((m) => (
              <Badge key={m} variant="outline">
                {m}
              </Badge>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs"
              aria-label="Refresh available models"
              title="Re-check the provider for loaded models"
              onClick={() => qc.invalidateQueries({ queryKey: ["ai-health"] })}
            >
              <Icon as={RotateCw} size="sm" /> Refresh
            </Button>
          </div>
        </Row>
        <Row label="Last explain latency (client)">
          <span className="text-sm tabular-nums text-muted-foreground">
            {aiMetrics.lastExplainMs != null
              ? `${(aiMetrics.lastExplainMs / 1000).toFixed(1)}s`
              : "—"}
            {aiMetrics.lastExplainAt && (
              <span className="ml-2 text-xs">
                ({new Date(aiMetrics.lastExplainAt).toLocaleString()})
              </span>
            )}
          </span>
        </Row>
        <Row label="Server explain p50">
          <span className="text-sm tabular-nums text-muted-foreground">
            {o?.explain_p50_ms != null
              ? `${(o.explain_p50_ms / 1000).toFixed(1)}s`
              : "—"}
          </span>
        </Row>
        <Row label="Embed coverage">
          <Badge variant="outline" className="tabular-nums">
            {o ? `${o.embed_coverage_pct}%` : "—"}
          </Badge>
        </Row>
        <Row label="Generation queue">
          <span className="text-sm tabular-nums text-muted-foreground">
            {o ? `${o.gen_queued} queued · ${o.gen_running} running` : "—"}
          </span>
        </Row>
        <Row label="Coach snapshot">
          <span className="text-sm tabular-nums text-muted-foreground">
            {o?.last_coach_refresh_ms != null
              ? `${Math.round(o.last_coach_refresh_ms / 60000)}m ago`
              : "—"}
          </span>
        </Row>
        <Row label="Offline generation">
          <Badge variant={o?.models.cloud_enabled ? "default" : "outline"}>
            {o?.models.cloud_enabled
              ? `cloud · ${o.models.cloud_gen_model}`
              : `local (${PROVIDER_LABEL[o?.models.local_provider ?? selectedProvider] ?? "Ollama"})`}
          </Badge>
        </Row>
        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pregen.isPending}
            onClick={() => pregen.mutate({ limit: 50 })}
          >
            {pregen.isPending ? "Warming…" : "Warm explanation cache"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Pre-generate explanations for weak / AI-generated items.
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {selectedProvider === "lmstudio"
            ? `Realtime AI runs locally via LMStudio at ${lmsUrl}.`
            : "Realtime AI runs locally via Ollama at localhost:11434."}
        </p>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * One editable model-role row. When the active provider lists loaded models it
 * renders a dropdown of them (plus a "type a custom id" escape hatch); when the
 * provider is unreachable it falls back to a free-text id input. Both write the
 * chosen id via /settings. This is what makes LMStudio usable end-to-end: after
 * switching providers you assign each role a model that actually exists locally.
 */
export function ModelRolePicker({
  label,
  value,
  models,
  missing,
  pending,
  onSave,
}: {
  label: string;
  value: string;
  models: string[];
  missing: boolean;
  pending: boolean;
  onSave: (v: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [draft, setDraft] = useState(value);
  // Health resolves AFTER mount, so the configured id often arrives only on a
  // later render. Resync the free-text draft to the authoritative value (which
  // changes only on save or a provider switch) so it never shows a stale/empty id.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const hasModels = models.length > 0;
  const inList = !!value && models.includes(value);
  // Always show the current value as an option even when it isn't loaded, so the
  // select reflects reality (and flags it as not-loaded).
  const options = inList || !value ? models : [value, ...models];
  const useInput = !hasModels || customMode;

  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-muted-foreground", missing && "text-foreground")}>
        {label}
      </span>
      {useInput ? (
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="model id"
            spellCheck={false}
            className="h-8 w-44 text-sm"
            aria-label={label}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !draft.trim() || draft.trim() === value}
            onClick={() => onSave(draft.trim())}
          >
            Save
          </Button>
          {hasModels && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCustomMode(false);
                setDraft(value);
              }}
            >
              Pick
            </Button>
          )}
        </div>
      ) : (
        <Select
          value={value || undefined}
          disabled={pending}
          onValueChange={(v) => {
            if (v === CUSTOM) {
              setDraft(value);
              setCustomMode(true);
              return;
            }
            onSave(v);
          }}
        >
          <SelectTrigger className="h-8 w-44 text-sm" aria-label={label}>
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {options.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
                {m === value && !inList ? " (not loaded)" : ""}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Type a custom id…</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
