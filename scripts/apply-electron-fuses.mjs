import path from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

export const ELECTRON_FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: false,
  // SECURITY DEBT, deliberately not flipped here: RunAsNode leaves the signed
  // app usable as a general-purpose script host (relaunching it with
  // ELECTRON_RUN_AS_NODE can read its own safeStorage keys). It cannot be
  // disabled on its own because the PACKAGED crash guard depends on it:
  // electron/main.js starts OwnedChildWatchdog unconditionally, and
  // electron/watchdog.js spawns `process.execPath` (the fused StudyVault
  // binary) with ELECTRON_RUN_AS_NODE=1 to run child-watchdog.cjs. With the
  // fuse off that spawn boots a second app instance, loses the single-instance
  // lock, exits, and every sidecar launches with crashGuardDegraded set.
  // Flip this to false only together with moving the watchdog child onto
  // Electron's utilityProcess.fork(), which needs no fuse.
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
});

export default async function applyElectronFuses(context) {
  const extension = {
    darwin: '.app',
    mas: '.app',
    win32: '.exe',
    linux: '',
  }[context.electronPlatformName];
  if (extension === undefined) {
    throw new Error(`unsupported Electron fuse platform: ${context.electronPlatformName}`);
  }
  const executablePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}${extension}`);
  await flipFuses(executablePath, ELECTRON_FUSE_CONFIG);
}
