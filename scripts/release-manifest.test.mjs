import { describe, expect, it } from 'vitest';
import {
  buildReleaseManifest,
  parseCargoLock,
  parseNpmLock,
  parseUvLock,
  validateReleaseManifest,
} from './release-manifest.mjs';

describe('release manifest evidence', () => {
  it('parses npm, Cargo, and uv lock components', () => {
    expect(
      parseNpmLock({
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'node_modules/react': { version: '19.2.5', integrity: 'sha512-react' },
        },
      }),
    ).toEqual([
      {
        ecosystem: 'npm',
        name: 'react',
        version: '19.2.5',
        dev: false,
        resolved: null,
        integrity: 'sha512-react',
      },
    ]);

    expect(
      parseCargoLock(`
[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"
`),
    ).toEqual([
      {
        ecosystem: 'cargo',
        name: 'serde',
        version: '1.0.0',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'abc',
      },
    ]);

    expect(
      parseUvLock(`
[[package]]
name = "fastapi"
version = "0.136.1"
source = { registry = "https://pypi.org/simple" }
`),
    ).toEqual([
      {
        ecosystem: 'pypi',
        name: 'fastapi',
        version: '0.136.1',
        source: null,
        checksum: null,
      },
    ]);
  });

  it('builds a manifest with lock hashes and SBOM component counts', async () => {
    const manifest = await buildReleaseManifest();
    const validation = validateReleaseManifest(manifest);

    expect(validation).toEqual({ ok: true, errors: [] });
    expect(manifest.versions.consistent).toBe(true);
    expect(manifest.lockfiles.every((entry) => entry.present && entry.sha256)).toBe(true);
    expect(manifest.sbom.counts.npm).toBeGreaterThan(0);
    expect(manifest.sbom.counts.cargo).toBeGreaterThan(0);
    expect(manifest.sbom.counts.pypi).toBeGreaterThan(0);
  });

  it('fails validation when release assets or required sidecar provenance are missing', () => {
    const manifest = {
      schema: 'studyvault.release-manifest.v1',
      versions: { consistent: true },
      lockfiles: [],
      sbom: { counts: { npm: 1, cargo: 1, pypi: 1 } },
      sidecarProvenance: { present: false, entries: [] },
      bundleAssets: [],
    };

    expect(validateReleaseManifest(manifest, { requireAssets: true }).ok).toBe(false);
    expect(validateReleaseManifest(manifest, { requireSidecarProvenance: true }).ok).toBe(false);
  });
});
