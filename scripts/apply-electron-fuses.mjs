import path from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

export const ELECTRON_FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: false,
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
