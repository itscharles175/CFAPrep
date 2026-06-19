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

// App-lifetime startup side-effects. Guarded so they run once even though the
// host tree may unmount/remount as the user soft-switches domains (legacy path)
// or stays persistently mounted (unified path).
let hostStarted = false;

export function runHostStartupOnce() {
  if (hostStarted) return;
  hostStarted = true;
  registerServiceWorker();
  // Re-activate the user's chosen storage backend BEFORE the data bootstraps
  // run, so they read/write through the correct driver. Falls back to Dexie.
  bootstrapStorage().finally(() => {
    bootstrapSourceVault();
    bootstrapAiContent();
    bootstrapFsrsParameters();
  });
}
