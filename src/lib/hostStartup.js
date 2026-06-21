// K4-7 — shared host app-lifetime startup, extracted from host-entry.jsx so BOTH
// the legacy host entry (flag-OFF) and the unified root (flag-ON) run the exact
// same one-time host bootstraps. Behavior is unchanged from the original inline
// `runHostStartupOnce` in host-entry.jsx — same guard, same order — so the
// flag-OFF path is byte-for-byte identical.
import { registerServiceWorker } from '../registerServiceWorker';
import { bootstrapSourceVault } from './bootstrapSourceVault';
import { bootstrapAiContent } from './bootstrapAiContent';
import { bootstrapFsrsParameters } from './bootstrapFsrsParameters';
import { bootstrapStorage } from './bootstrapStorage';
import { requestPersistentStorage } from './storage/quota';
import { unlockSecureVaultOnLaunch } from './secureVault';

// App-lifetime startup side-effects. Guarded so they run once even though the
// host tree may unmount/remount as the user soft-switches domains (legacy path)
// or stays persistently mounted (unified path).
let hostStarted = false;

export function runHostStartupOnce() {
  if (hostStarted) return;
  hostStarted = true;
  registerServiceWorker();
  // GAP-QUOTA-1 — request persistent (eviction-exempt) storage on every boot.
  // The local IndexedDB vault is the user's only copy, so we ask the browser to
  // exempt this origin from storage-pressure eviction. Fire-and-forget: the
  // helper never throws and never blocks the data bootstraps below; the extra
  // .catch is belt-and-braces against an unexpected synchronous throw.
  try {
    void requestPersistentStorage().catch(() => {});
  } catch {
    /* boot must proceed even if persistence can't be requested */
  }
  // Re-activate the user's chosen storage backend BEFORE the data bootstraps
  // run, so they read/write through the correct driver. Falls back to Dexie.
  bootstrapStorage()
    // GAP-SEC-1 — if the opt-in secure vault is enabled, unlock it (load the DEK
    // from the OS keychain) before the data bootstraps so encrypted rows can be
    // read. A no-op + fast resolve when the vault is disabled (the default), so
    // this path is unchanged for everyone who hasn't opted in. Never throws — but
    // a failed unlock of an ENABLED vault is logged (not silently swallowed) so it
    // is visible; once per-record encryption is wired this must become a gate
    // before the data bootstraps (reading encrypted stores while locked would
    // corrupt). Today no rows are encrypted, so proceeding is safe.
    .then(() =>
      unlockSecureVaultOnLaunch()
        .then((status) => {
          if (status.enabled && !status.unlocked) {
            console.warn('[secureVault] enabled but failed to unlock on launch:', status.error);
          }
        })
        .catch(() => undefined),
    )
    .finally(() => {
      bootstrapSourceVault();
      bootstrapAiContent();
      bootstrapFsrsParameters();
    });
}
