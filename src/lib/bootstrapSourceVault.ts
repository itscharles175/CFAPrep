import { getCfaSourceMapStatus, importCfaSourceBundle } from './cfaSourceVault';

const BUNDLE_URL = '/cfa-source.qvsource';

export interface BootstrapSourceVaultResult {
  loaded: boolean;
  reason?: 'already-populated' | 'no-bundle' | 'error';
  error?: string;
  documents?: number;
  chunks?: number;
  indexes?: number;
  mode?: 'replace' | 'merge';
}

let bootstrapPromise: Promise<BootstrapSourceVaultResult> | undefined;

/**
 * First-run loader: if the local source vault is empty and a bundle has been
 * installed into public/ (via `npm run cfa:source:install`), fetch it once and
 * import the curriculum into IndexedDB. Idempotent and non-blocking — safe to
 * call on every app start. Fully local; no network beyond the same-origin fetch.
 */
export function bootstrapSourceVault(): Promise<BootstrapSourceVaultResult> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      const status = await getCfaSourceMapStatus();
      if (status.documentCount > 0) return { loaded: false, reason: 'already-populated' };
      const response = await fetch(BUNDLE_URL, { cache: 'no-store' });
      if (!response.ok) return { loaded: false, reason: 'no-bundle' };
      const bundle = await response.json();
      const result = await importCfaSourceBundle(bundle, { mode: 'replace' });
      return { loaded: true, ...result };
    } catch (error) {
      return {
        loaded: false,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  return bootstrapPromise;
}
