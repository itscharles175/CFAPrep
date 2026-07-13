/**
 * INT-2 — Model-routing edit modal (System Health), HOST-ONLY.
 *
 * The LSAT Backend panel surfaces the sidecar's effective model routing
 * (explain / gen / diagnose ids) read-only (S5-A) and offers a one-click
 * "Match host provider" sync (S5-B). This modal is the full editor: the user
 * can retarget each per-role model id and the provider/endpoint directly, then
 * push the patch to the backend (`PUT /api/settings`, already shipped). On save
 * it re-probes BOTH the LSAT sidecar health and the host's local-LLM connection
 * so the page's read-only display refreshes immediately, and it warns when the
 * backend reports configured models the active provider can't currently serve.
 *
 * The prompt/schema version stamps are shown read-only — they are metadata
 * emitted by the backend (the cross-domain schema version comes from the
 * already-surfaced schema-versions handshake), NOT editable inputs.
 *
 * Persist + re-probe functions are injected with library defaults so the host
 * wires it up with zero extra plumbing while tests pass deterministic spies.
 */
import { useState, type ReactNode } from 'react';
import { Dialog } from '../ui/Primitives';
import {
  syncProviderToLsat as defaultSyncProviderToLsat,
  pushModelRoutingToLsat as defaultPushModelRoutingToLsat,
  checkLsatBackendHealth as defaultCheckLsatBackendHealth,
  type LsatBackendHealth,
  type LsatModelRoutingPatch,
} from '../../lib/lsatBackend';
import { checkLlmConnection as defaultCheckLlmConnection } from '../../lib/localLlm';

/** The host's local-LLM settings (subset the modal reads). */
export interface HostLlmInfo {
  baseUrl?: string;
  model?: string;
}

/** The effective LSAT routing the backend reports (read-only seed for the fields). */
export interface LsatRoutingInfo {
  provider?: string;
  /** explain / gen / diagnose model ids the sidecar currently routes to. */
  models?: { explain?: string; gen?: string; diagnose?: string };
  /** Configured ids the active provider can't serve (drives the warning). */
  missingModels?: string[];
}

export interface EditModelRoutingModalProps {
  /** Render nothing when closed (so the host can mount it unconditionally). */
  open: boolean;
  onClose: () => void;
  /** Host provider/endpoint seed (Local AI section). */
  host?: HostLlmInfo | null;
  /** Effective LSAT routing seed (from the AI-health probe). */
  lsat?: LsatRoutingInfo | null;
  /**
   * Read-only metadata stamps. `schemaVersion` is the cross-domain schema
   * version from the schema-versions handshake (already surfaced on the page);
   * `promptVersion` is the backend's prompt-template stamp when reported.
   */
  schemaVersion?: number | null;
  promptVersion?: string | number | null;
  /**
   * Called after a successful save + re-probe with the refreshed LSAT health so
   * the host can update its read-only display in one place.
   */
  onSaved?: (health: LsatBackendHealth) => void;
  /** Optional toast/banner sink for the result message. */
  onMessage?: (message: string) => void;
  // --- Injected for testability (default to the shipped library fns) --------
  pushRouting?: typeof defaultPushModelRoutingToLsat;
  syncProvider?: typeof defaultSyncProviderToLsat;
  reprobeLsat?: typeof defaultCheckLsatBackendHealth;
  reprobeHostLlm?: typeof defaultCheckLlmConnection;
}

/** Infer the local provider from a host base URL (Ollama :11434 vs LM Studio). */
function inferLocalProvider(baseUrl: string | undefined): 'ollama' | 'lmstudio' {
  return /11434|ollama/i.test(baseUrl || '') ? 'ollama' : 'lmstudio';
}

export default function EditModelRoutingModal({
  open,
  onClose,
  host,
  lsat,
  schemaVersion,
  promptVersion,
  onSaved,
  onMessage,
  pushRouting = defaultPushModelRoutingToLsat,
  syncProvider = defaultSyncProviderToLsat,
  reprobeLsat = defaultCheckLsatBackendHealth,
  reprobeHostLlm = defaultCheckLlmConnection,
}: EditModelRoutingModalProps) {
  const [explainModel, setExplainModel] = useState(lsat?.models?.explain ?? '');
  const [genModel, setGenModel] = useState(lsat?.models?.gen ?? '');
  const [diagnoseModel, setDiagnoseModel] = useState(lsat?.models?.diagnose ?? '');
  const [genProvider, setGenProvider] = useState<'ollama' | 'cloud'>(
    lsat?.provider === 'cloud' ? 'cloud' : 'ollama',
  );
  const [localProvider, setLocalProvider] = useState<'ollama' | 'lmstudio'>(
    inferLocalProvider(host?.baseUrl),
  );
  const [lmstudioUrl, setLmstudioUrl] = useState(host?.baseUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const missingModels = lsat?.missingModels ?? [];
  const hasMissing = missingModels.length > 0;

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const patch: LsatModelRoutingPatch = {
        explain_model: explainModel,
        gen_model: genModel,
        diagnose_model: diagnoseModel,
        gen_provider: genProvider,
        local_provider: localProvider,
        // Only meaningful for LM Studio; the helper drops empty values.
        ...(localProvider === 'lmstudio' ? { lmstudio_url: lmstudioUrl } : {}),
      };
      const result = await pushRouting(patch);
      if (!result.ok) {
        setError(result.detail);
        onMessage?.(result.detail);
        return;
      }
      onMessage?.(result.detail);
      // Re-probe BOTH planes so the page's read-only routing display + the host
      // Local-AI connection badge refresh from ground truth, not the form state.
      const [health] = await Promise.all([
        reprobeLsat(),
        // Host LLM connection re-probe is best-effort — its result feeds the
        // page's own status; we just trigger it here so the display refreshes.
        reprobeHostLlm({ baseUrl: lmstudioUrl, model: host?.model }).catch(() => null),
      ]);
      onSaved?.(health);
      onClose();
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Could not update LSAT model routing.';
      setError(detail);
      onMessage?.(detail);
    } finally {
      setBusy(false);
    }
  }

  async function handleMatchHost() {
    setBusy(true);
    setError(null);
    try {
      const result = await syncProvider({ baseUrl: host?.baseUrl });
      onMessage?.(result.detail);
      if (result.ok && result.applied) {
        // Reflect the synced provider/endpoint in the form so a follow-up Save
        // doesn't overwrite it with stale values.
        setLocalProvider(result.applied.local_provider === 'ollama' ? 'ollama' : 'lmstudio');
        if (result.applied.lmstudio_url) setLmstudioUrl(result.applied.lmstudio_url);
      } else if (!result.ok) {
        setError(result.detail);
      }
      const health = await reprobeLsat();
      onSaved?.(health);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Could not match the host provider.';
      setError(detail);
      onMessage?.(detail);
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, value: string, onChange: (v: string) => void, placeholder: string): ReactNode => (
    <label className="qv-stack-1">
      <span className="qv-fs-xs qv-text-muted">{label}</span>
      <input
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        disabled={busy}
      />
    </label>
  );

  return (
    <Dialog
      title="Edit LSAT model routing"
      description="Retarget the per-role model ids and the provider the LSAT sidecar uses. Changes are written to the backend and both health checks re-run."
      onClose={busy ? () => {} : onClose}
      className="edit-model-routing-modal"
      actions={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save routing'}
          </button>
        </>
      }
    >
      {hasMissing && (
        <p className="qv-m-0 qv-mb-3 qv-fs-sm qv-text-warning" role="alert">
          Configured model{missingModels.length > 1 ? 's' : ''} not loaded in the active provider:{' '}
          <span className="qv-mono">{missingModels.join(', ')}</span> — pull/load{' '}
          {missingModels.length > 1 ? 'them' : 'it'} or pick a model the provider already serves below.
        </p>
      )}

      <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        {field('Explain model', explainModel, setExplainModel, 'e.g. gemma3:4b')}
        {field('Generation model', genModel, setGenModel, 'e.g. gemma3:4b')}
        {field('Diagnose model', diagnoseModel, setDiagnoseModel, 'e.g. gemma3:4b')}
      </div>

      <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <label className="qv-stack-1">
          <span className="qv-fs-xs qv-text-muted">Generation provider</span>
          <select
            className="input"
            value={genProvider}
            onChange={(event) => setGenProvider(event.target.value === 'cloud' ? 'cloud' : 'ollama')}
            aria-label="Generation provider"
            disabled={busy}
          >
            <option value="ollama">Local (Ollama)</option>
            <option value="cloud">Cloud</option>
          </select>
        </label>
        <label className="qv-stack-1">
          <span className="qv-fs-xs qv-text-muted">Local provider</span>
          <select
            className="input"
            value={localProvider}
            onChange={(event) => setLocalProvider(event.target.value === 'ollama' ? 'ollama' : 'lmstudio')}
            aria-label="Local provider"
            disabled={busy}
          >
            <option value="ollama">Ollama</option>
            <option value="lmstudio">LM Studio</option>
          </select>
        </label>
        {localProvider === 'lmstudio'
          ? field('LM Studio URL', lmstudioUrl, setLmstudioUrl, 'http://localhost:1234/v1')
          : null}
      </div>

      <div className="qv-row-2" style={{ flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={handleMatchHost}
          disabled={busy || !host?.baseUrl}
          title={host?.baseUrl ? 'Set LSAT to use the host model provider' : 'Configure a host model server first'}
        >
          Match host provider
        </button>
      </div>

      {/* Read-only metadata stamps — NOT editable inputs. */}
      <p className="qv-m-0 qv-fs-xs qv-text-muted qv-mono">
        {[
          schemaVersion != null ? `schema v${schemaVersion}` : null,
          promptVersion != null && promptVersion !== '' ? `prompt ${promptVersion}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'No version metadata reported.'}
      </p>

      {error && (
        <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-danger" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
