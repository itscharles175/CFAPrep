import { describe, expect, it } from 'vitest';
import { SURREALDB_ASSETS, SURREALDB_VERSION, resolveSurrealAsset } from './stage-surreal-binary.mjs';

describe('SurrealDB release asset policy', () => {
  it('pins every Electron release target to an immutable SHA-256', () => {
    expect(Object.keys(SURREALDB_ASSETS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
    for (const asset of Object.values(SURREALDB_ASSETS)) {
      expect(asset.name).toContain(`v${SURREALDB_VERSION}`);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.executable).toMatch(/^surreal2(?:\.exe)?$/);
    }
  });

  it('rejects release architectures without a pinned asset', () => {
    expect(resolveSurrealAsset('win32', 'x64')).toMatchObject({
      executable: 'surreal2.exe',
      key: 'win32-x64',
    });
    expect(() => resolveSurrealAsset('win32', 'arm64')).toThrow(/unsupported SurrealDB release target/);
  });
});
