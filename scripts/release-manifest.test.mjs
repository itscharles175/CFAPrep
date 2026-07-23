import { describe, expect, it } from 'vitest';
import { buildReleaseManifest, parseNpmLock, parseUvLock, validateReleaseManifest } from './release-manifest.mjs';
import { SIGNING_EVIDENCE_SCHEMA } from './release-signing.mjs';

function verifiedWindowsSigning() {
  const artifact = (kind, path, published) => ({
    path,
    kind,
    size: 100,
    sha256: (kind === 'app' ? 'a' : kind === 'nsis' ? 'b' : 'c').repeat(64),
    published,
    signed: true,
    verified: true,
    timestamped: true,
    notarized: null,
    signer: { thumbprint: 'A'.repeat(40) },
    timestamp: { thumbprint: 'B'.repeat(40) },
  });
  return {
    schema: SIGNING_EVIDENCE_SCHEMA,
    platform: 'windows',
    required: true,
    status: 'verified',
    artifacts: [
      artifact('app', 'StudyVault.exe', false),
      artifact('nsis', 'release/StudyVault-0.9.0-win-x64.exe', true),
      artifact('msi', 'release/StudyVault-0.9.0-win-x64.msi', true),
    ],
  };
}

describe('release manifest evidence', () => {
  it('parses npm and uv lock components', () => {
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
    expect(manifest.sbom.counts.pypi).toBeGreaterThan(0);
  });

  it('fails validation when release assets or required sidecar provenance are missing', () => {
    const manifest = {
      schema: 'studyvault.release-manifest.v2',
      versions: { consistent: true },
      lockfiles: [],
      sbom: { counts: { npm: 1, pypi: 1 } },
      sidecarProvenance: { present: false, entries: [] },
      bundleAssets: [],
    };

    expect(validateReleaseManifest(manifest, { requireAssets: true }).ok).toBe(false);
    expect(validateReleaseManifest(manifest, { requireSidecarProvenance: true }).ok).toBe(false);
  });

  it('requires artifact-level signing evidence for strict release manifests', () => {
    const manifest = {
      schema: 'studyvault.release-manifest.v2',
      versions: { consistent: true },
      lockfiles: [],
      sbom: { counts: { npm: 1, pypi: 1 } },
      sidecarProvenance: { present: true, entries: [{ service: 'LSAT backend' }] },
      bundleAssets: [
        {
          path: 'release/StudyVault-0.9.0-win-x64.exe',
          sha256: 'b'.repeat(64),
          size: 100,
        },
        {
          path: 'release/StudyVault-0.9.0-win-x64.msi',
          sha256: 'c'.repeat(64),
          size: 100,
        },
      ],
      signing: verifiedWindowsSigning(),
    };
    expect(validateReleaseManifest(manifest, { requireSigning: true, signingPlatform: 'windows' })).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validateReleaseManifest(
        { ...manifest, signing: { ...verifiedWindowsSigning(), status: 'configured', artifacts: [] } },
        { requireSigning: true, signingPlatform: 'windows' },
      ).ok,
    ).toBe(false);
  });
});
