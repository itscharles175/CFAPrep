/**
 * GAP-SEC-1 — opt-in "Secure vault" control surface.
 *
 * Lets the user turn on encryption-at-rest for the live vault. The key is
 * generated locally and custodied by the OS keychain (never escrowed); enabling
 * is only possible in the desktop app (the keychain backend). This panel drives
 * the {@link secureVault} controller and reflects its enabled / unlocked / key-
 * store-available status. Pure presentation over the controller — no crypto here.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getSecureVaultStatus,
  secureVault,
  type SecureVaultStatus,
} from '../lib/secureVault';

export default function SecureVaultPanel() {
  const [status, setStatus] = useState<SecureVaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await getSecureVaultStatus());
    } catch {
      setStatus({ enabled: false, unlocked: false, available: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error || 'Action failed.');
        } else {
          setNotice(okMsg);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return (
    <section className="qv-card qv-mt-4" aria-labelledby="secure-vault-heading">
      <h3 id="secure-vault-heading" className="qv-m-0">
        Secure vault <span className="qv-text-muted qv-fs-sm">(preview)</span>
      </h3>
      <p className="qv-text-secondary qv-mt-1 qv-mb-0">
        Provisions a local encryption key for at-rest protection of your study data. The key is
        generated on this device and held in your operating system’s keychain — never uploaded or
        escrowed. Enabling now sets up and unlocks the key; per-record encryption of your stores is
        being rolled out incrementally. Desktop app only.
      </p>

      {status && (
        <p className="qv-fs-sm qv-mt-2 qv-mb-0 qv-text-secondary">
          Status:{' '}
          {!status.available ? (
            <span className="qv-text-warning">OS keychain unavailable here (desktop app only).</span>
          ) : status.enabled ? (
            <>
              <span className="qv-text-success">Enabled</span> ·{' '}
              {status.unlocked ? (
                <span className="qv-text-success">unlocked</span>
              ) : (
                <span className="qv-text-warning">locked</span>
              )}
            </>
          ) : (
            <span>Not enabled.</span>
          )}
        </p>
      )}

      <div className="qv-row-2 qv-mt-3" style={{ flexWrap: 'wrap' }}>
        {status?.available && !status.enabled && (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => run(() => secureVault.enable(), 'Secure vault enabled and unlocked.')}
          >
            {busy ? 'Working…' : 'Enable secure vault'}
          </button>
        )}
        {status?.enabled && !status.unlocked && (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => run(() => secureVault.unlock(), 'Vault unlocked.')}
          >
            {busy ? 'Working…' : 'Unlock'}
          </button>
        )}
        {status?.enabled && status.unlocked && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => {
              secureVault.lock();
              setNotice('Vault locked.');
              setError('');
              void refresh();
            }}
          >
            Lock
          </button>
        )}
        {status?.enabled && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => run(() => secureVault.disable(), 'Secure vault disabled.')}
          >
            {busy ? 'Working…' : 'Disable secure vault'}
          </button>
        )}
      </div>

      {error && <p className="qv-text-danger qv-fs-sm qv-mt-2 qv-mb-0">{error}</p>}
      {notice && !error && <p className="qv-text-success qv-fs-sm qv-mt-2 qv-mb-0">{notice}</p>}
    </section>
  );
}
