import { spawnSync } from 'node:child_process';
import path from 'node:path';

import applyElectronFuses from './apply-electron-fuses.mjs';

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

function plistBuddy(infoPlist, command, { optional = false } = {}) {
  const result = spawnSync(PLIST_BUDDY, ['-c', command, infoPlist], {
    encoding: 'utf8',
  });
  if (result.status !== 0 && !optional) {
    throw new Error(`PlistBuddy failed (${command}): ${result.stderr || result.stdout}`);
  }
}

function deleteKey(infoPlist, key) {
  plistBuddy(infoPlist, `Delete :${key}`, { optional: true });
}

export function hardenPersonalInfoPlist(infoPlist) {
  deleteKey(infoPlist, 'NSAppTransportSecurity');
  plistBuddy(infoPlist, 'Add :NSAppTransportSecurity dict');
  plistBuddy(infoPlist, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false');
  plistBuddy(infoPlist, 'Add :NSAppTransportSecurity:NSExceptionDomains dict');
  for (const host of ['localhost', '127.0.0.1']) {
    plistBuddy(infoPlist, `Add :NSAppTransportSecurity:NSExceptionDomains:${host} dict`);
    plistBuddy(infoPlist, `Add :NSAppTransportSecurity:NSExceptionDomains:${host}:NSExceptionAllowsInsecureHTTPLoads bool true`);
    plistBuddy(infoPlist, `Add :NSAppTransportSecurity:NSExceptionDomains:${host}:NSIncludesSubdomains bool false`);
  }

  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSLocationAlwaysAndWhenInUseUsageDescription',
    'NSLocationAlwaysUsageDescription',
    'NSLocationUsageDescription',
    'NSLocationWhenInUseUsageDescription',
    'NSSerialPortUsageDescription',
    'NSUSBRestrictedMode',
  ]) deleteKey(infoPlist, key);

  deleteKey(infoPlist, 'NSMicrophoneUsageDescription');
  plistBuddy(
    infoPlist,
    'Add :NSMicrophoneUsageDescription string StudyVault uses the microphone only when you start voice study.',
  );

  const lint = spawnSync('plutil', ['-lint', infoPlist], { encoding: 'utf8' });
  if (lint.status !== 0) throw new Error(`invalid hardened Info.plist: ${lint.stderr || lint.stdout}`);
}

export default async function preparePersonalMacosBundle(context) {
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    hardenPersonalInfoPlist(path.join(appPath, 'Contents', 'Info.plist'));
  }
  await applyElectronFuses(context);
}
