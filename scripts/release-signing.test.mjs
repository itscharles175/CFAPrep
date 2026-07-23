import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
// collectBundleAssets is imported here on purpose: the bundle-hash test below
// must run BOTH walkers - signing evidence and manifest assets - over one
// fixture and prove their digests agree.
import { collectBundleAssets } from './release-manifest.mjs';
import {
  SIGNING_EVIDENCE_SCHEMA,
  buildWindowsSigningConfig,
  hashDirectory,
  inspectCredentialSet,
  normalizePlatform,
  normalizeThumbprint,
  resolveEffectiveBuilderConfig,
  validateEffectiveBuilderConfig,
  validateSigningAssetBindings,
  validateSigningEvidence,
  verifyMacArtifacts,
  verifyWindowsArtifacts,
} from './release-signing.mjs';

function repoRelative(path) {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

const TEMP_DIRS = [];

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'studyvault-signing-'));
  TEMP_DIRS.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const WINDOWS_ENV = {
  WINDOWS_CERT_BASE64: 'c2lnbmVkLXBmeA==',
  WINDOWS_CERT_PASSWORD: 'test-password',
  WINDOWS_CERT_THUMBPRINT: 'a'.repeat(40),
};

const MAC_ENV = {
  APPLE_CERTIFICATE_BASE64: 'c2lnbmVkLXAxMg==',
  APPLE_CERTIFICATE_PASSWORD: 'test-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: StudyVault (TEAM123456)',
  APPLE_ID: 'release@example.invalid',
  APPLE_PASSWORD: 'app-specific-password',
  APPLE_TEAM_ID: 'TEAM123456',
};

describe('release signing policy', () => {
  it('normalizes runner platform names and certificate thumbprints', () => {
    expect(normalizePlatform('windows-latest')).toBe('windows');
    expect(normalizePlatform('darwin')).toBe('macos');
    expect(normalizePlatform('ubuntu-latest')).toBe('linux');
    expect(normalizeThumbprint('aa bb')).toBe('AABB');
  });

  it('fails closed for absent, partial, or invalid Windows credentials', () => {
    expect(inspectCredentialSet('windows', {}).complete).toBe(false);
    expect(inspectCredentialSet('windows', { WINDOWS_CERT_BASE64: 'x' }).missing).toContain('WINDOWS_CERT_PASSWORD');
    expect(inspectCredentialSet('windows', { ...WINDOWS_ENV, WINDOWS_CERT_THUMBPRINT: 'bad' }).errors).toHaveLength(1);
    expect(inspectCredentialSet('windows', WINDOWS_ENV)).toMatchObject({ complete: true, required: true });
  });

  it('requires the complete macOS signing and notarization credential set', () => {
    expect(inspectCredentialSet('macos', { ...MAC_ENV, APPLE_TEAM_ID: '' }).missing).toEqual(['APPLE_TEAM_ID']);
    expect(inspectCredentialSet('macos', MAC_ENV)).toMatchObject({ complete: true, required: true });
    expect(inspectCredentialSet('linux', {})).toMatchObject({ complete: true, required: false });
  });

  it('creates the electron-builder Windows config overlay from the expected signer', () => {
    expect(buildWindowsSigningConfig(WINDOWS_ENV.WINDOWS_CERT_THUMBPRINT)).toEqual({
      extends: 'electron-builder.yml',
      win: { signtoolOptions: { certificateSha1: 'A'.repeat(40) } },
    });
  });

  it('wires the Windows signing overlay from release preflight into Electron Builder', async () => {
    const workflow = await readFile(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    // The overlay must never live under dist/: `npm run electron:build` runs
    // `vite build` first, which empties dist/ before electron-builder reads it.
    expect(workflow).not.toContain('dist/windows-signing-config.json');
    expect(workflow).toContain('--config-output ${{ runner.temp }}/windows-signing-config.json');
    expect(workflow).toContain("format('--config {0}/windows-signing-config.json', runner.temp)");
    expect(workflow).toContain('node scripts/release-signing.mjs assert-config');
    // certificateSha1 resolves through the Windows certificate store, so the PFX
    // import is the credential path that actually signs.
    expect(workflow).toContain('Import-PfxCertificate');
    expect(workflow).not.toContain('CSC_LINK: ${{ matrix.platform == \'windows\'');

    const local = await readFile(join(process.cwd(), 'scripts', 'release_local.py'), 'utf8');
    expect(local).toContain('WINDOWS_SIGNING_CONFIG = Path(tempfile.gettempdir())');
    expect(local).not.toContain('WINDOWS_SIGNING_CONFIG = DIST_DIR');
  });

  it('rejects an effective electron-builder config that lost the packaging invariants', async () => {
    const dir = await tempDir();
    const overlay = join(dir, 'windows-signing-config.json');
    await writeFile(overlay, JSON.stringify(buildWindowsSigningConfig(WINDOWS_ENV.WINDOWS_CERT_THUMBPRINT)));
    const merged = await resolveEffectiveBuilderConfig(overlay);
    expect(
      validateEffectiveBuilderConfig(merged, { expectedThumbprint: WINDOWS_ENV.WINDOWS_CERT_THUMBPRINT }),
    ).toEqual({ ok: true, errors: [] });

    // An overlay without `extends` is what electron-builder actually loaded
    // before this fix: --config REPLACES electron-builder.yml wholesale.
    await writeFile(overlay, JSON.stringify({ win: { signtoolOptions: { certificateSha1: 'A'.repeat(40) } } }));
    const replaced = await resolveEffectiveBuilderConfig(overlay);
    const validation = validateEffectiveBuilderConfig(replaced);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual([
      'forceCodeSigning must remain true',
      "directories.output must remain 'release'",
      'win.target must still include nsis',
      'win.target must still include msi',
      'extraResources must still stage the sidecar services directory',
      'afterPack must still apply the Electron fuses',
    ]);
  });

  it('hashes bundle directories identically for signing evidence and manifest assets', async () => {
    // The fixture lives under the repo because manifest asset paths are
    // repo-relative, and it carries the two entry kinds the two walkers used to
    // disagree on: a symlink (every real .app bundle is full of them) and a
    // zero-byte file.
    const root = await mkdtemp(join(process.cwd(), '.studyvault-bundle-fixture-'));
    try {
      const app = join(root, 'StudyVault.app');
      const versions = join(app, 'Contents', 'Frameworks', 'Squirrel.framework', 'Versions');
      await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
      await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });
      await mkdir(join(versions, 'A'), { recursive: true });
      await writeFile(join(app, 'Contents', 'MacOS', 'StudyVault'), 'app-binary');
      await writeFile(join(app, 'Contents', 'Resources', 'empty.pak'), '');
      await writeFile(join(versions, 'A', 'Squirrel'), 'framework-binary');
      // 'junction' is the only symlink flavour a non-elevated Windows runner can
      // create; POSIX ignores the type and makes a plain directory symlink.
      await symlink(join(versions, 'A'), join(versions, 'Current'), 'junction');

      const directory = await hashDirectory(app);
      const assets = await collectBundleAssets({ root });
      const paths = assets.map((asset) => asset.path.slice(`${repoRelative(app)}/`.length));

      expect(paths).toContain('Contents/Resources/empty.pak');
      expect(paths.filter((path) => path.includes('Versions/Current'))).toEqual([]);
      expect(
        validateSigningAssetBindings(
          {
            schema: SIGNING_EVIDENCE_SCHEMA,
            platform: 'macos',
            required: true,
            status: 'verified',
            artifacts: [
              {
                path: repoRelative(app),
                kind: 'app',
                size: directory.size,
                sha256: directory.sha256,
                published: true,
                signed: true,
                verified: true,
              },
            ],
          },
          assets,
        ),
      ).toEqual({ ok: true, errors: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts verified Authenticode evidence and rejects unsigned evidence', () => {
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
    const verified = {
      schema: SIGNING_EVIDENCE_SCHEMA,
      platform: 'windows',
      required: true,
      status: 'verified',
      artifacts: [
        artifact('app', 'StudyVault.exe', false),
        artifact('nsis', 'release/StudyVault-setup.exe', true),
        artifact('msi', 'release/StudyVault.msi', true),
      ],
    };
    expect(validateSigningEvidence(verified, { requireSigned: true })).toEqual({ ok: true, errors: [] });
    expect(
      validateSigningEvidence(
        {
          ...verified,
          artifacts: verified.artifacts.map((item, index) =>
            index === 0 ? { ...item, timestamped: false, timestamp: null } : item,
          ),
        },
        { requireSigned: true },
      ).errors,
    ).toContain('one or more Windows artifacts lack trusted timestamp evidence');
    expect(
      validateSigningEvidence({ ...verified, status: 'configured', artifacts: [] }, { requireSigned: true }).ok,
    ).toBe(false);
  });

  it('requires notarized macOS artifacts and labels Linux as not applicable', () => {
    const macArtifact = (kind) => ({
      path: `release/${kind === 'app' ? 'mac/StudyVault.app' : 'StudyVault.dmg'}`,
      kind,
      size: 100,
      sha256: (kind === 'app' ? 'a' : 'd').repeat(64),
      published: true,
      signed: true,
      verified: true,
      timestamped: true,
      notarized: kind === 'app' ? false : null,
      stapled: kind === 'app' ? false : null,
      signer: {
        authority: MAC_ENV.APPLE_SIGNING_IDENTITY,
        teamIdentifier: MAC_ENV.APPLE_TEAM_ID,
        timestamp: 'Jul 16, 2026 at 13:00:00',
      },
    });
    const mac = {
      schema: SIGNING_EVIDENCE_SCHEMA,
      platform: 'macos',
      required: true,
      status: 'verified',
      artifacts: [macArtifact('app'), macArtifact('dmg')],
    };
    expect(validateSigningEvidence(mac, { requireSigned: true }).errors).toContain(
      'the macOS app lacks notarization/stapling evidence',
    );
    const verifiedMac = {
      ...mac,
      artifacts: mac.artifacts.map((item) => ({
        ...item,
        notarized: item.kind === 'app' ? true : null,
        stapled: item.kind === 'app' ? true : null,
      })),
    };
    expect(validateSigningEvidence(verifiedMac, { requireSigned: true })).toEqual({ ok: true, errors: [] });
    expect(
      validateSigningEvidence({
        schema: SIGNING_EVIDENCE_SCHEMA,
        platform: 'linux',
        required: false,
        status: 'not_applicable',
        artifacts: [],
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it('binds published signing evidence to exact release asset hashes', () => {
    const signing = {
      schema: SIGNING_EVIDENCE_SCHEMA,
      platform: 'windows',
      required: true,
      status: 'verified',
      artifacts: [
        {
          path: 'app.exe',
          kind: 'app',
          size: 10,
          sha256: 'a'.repeat(64),
          published: false,
          signed: true,
          verified: true,
          timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) },
          timestamp: { thumbprint: 'D'.repeat(40) },
        },
        {
          path: 'release/app.exe',
          kind: 'nsis',
          size: 20,
          sha256: 'b'.repeat(64),
          published: true,
          signed: true,
          verified: true,
          timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) },
          timestamp: { thumbprint: 'D'.repeat(40) },
        },
        {
          path: 'release/app.msi',
          kind: 'msi',
          size: 30,
          sha256: 'c'.repeat(64),
          published: true,
          signed: true,
          verified: true,
          timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) },
          timestamp: { thumbprint: 'D'.repeat(40) },
        },
      ],
    };
    const assets = signing.artifacts
      .filter((item) => item.published)
      .map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    expect(validateSigningAssetBindings(signing, assets)).toEqual({ ok: true, errors: [] });
    expect(
      validateSigningAssetBindings(
        signing,
        assets.map((item) => ({ ...item, sha256: 'f'.repeat(64) })),
      ).ok,
    ).toBe(false);
    expect(
      validateSigningAssetBindings(signing, [...assets, { ...assets[0], sha256: 'f'.repeat(64) }]).errors,
    ).toContain('bundle asset paths must be present and unique');
  });

  it('discovers and verifies the Windows app, NSIS, and MSI artifacts', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'win-unpacked'), { recursive: true });
    await writeFile(join(root, 'win-unpacked', 'StudyVault.exe'), 'app');
    await writeFile(join(root, 'StudyVault-setup.exe'), 'nsis');
    await writeFile(join(root, 'StudyVault.msi'), 'msi');
    const inspected = [];
    const evidence = await verifyWindowsArtifacts({
      bundleRoot: root,
      expectedThumbprint: 'A'.repeat(40),
      signatureInspector: (path) => {
        inspected.push(path);
        return {
          status: 'Valid',
          thumbprint: 'A'.repeat(40),
          subject: 'StudyVault Test',
          timestampThumbprint: 'B'.repeat(40),
        };
      },
    });

    expect(inspected).toHaveLength(3);
    expect(new Set(evidence.artifacts.map((item) => item.kind))).toEqual(new Set(['app', 'nsis', 'msi']));
    expect(
      evidence.artifacts
        .filter((item) => item.published)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(['msi', 'nsis']);
    expect(validateSigningEvidence(evidence, { requireSigned: true }).ok).toBe(true);
  });

  it('verifies and staples the macOS app without requiring a DMG staple', async () => {
    const root = await tempDir();
    const app = join(root, 'mac', 'StudyVault.app');
    const appBinary = join(app, 'Contents', 'MacOS', 'StudyVault');
    const dmg = join(root, 'StudyVault.dmg');
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(appBinary, 'app-binary');
    await writeFile(dmg, 'dmg');
    const commands = [];
    const evidence = await verifyMacArtifacts({
      bundleRoot: root,
      expectedIdentity: MAC_ENV.APPLE_SIGNING_IDENTITY,
      expectedTeamId: MAC_ENV.APPLE_TEAM_ID,
      commandRunner: (command, args) => commands.push({ command, args }),
      codeSignInspector: () => ({
        authority: MAC_ENV.APPLE_SIGNING_IDENTITY,
        teamIdentifier: MAC_ENV.APPLE_TEAM_ID,
        timestamp: 'Jul 16, 2026 at 13:00:00',
      }),
    });

    const stapleTargets = commands
      .filter((item) => item.command === 'xcrun' && item.args[0] === 'stapler')
      .map((item) => item.args.at(-1));
    expect(stapleTargets).toEqual([app]);
    expect(commands.map((item) => [item.command, item.args[0], item.args.at(-1)])).toEqual([
      ['codesign', '--verify', app],
      ['spctl', '--assess', app],
      ['xcrun', 'stapler', app],
      ['codesign', '--verify', dmg],
      ['spctl', '--assess', dmg],
    ]);
    expect(evidence.artifacts.find((item) => item.kind === 'dmg')).toMatchObject({
      notarized: null,
      stapled: null,
    });
    expect(validateSigningEvidence(evidence, { requireSigned: true }).ok).toBe(true);

    const appHash = createHash('sha256')
      .update(
        `Contents/MacOS/StudyVault\0${createHash('sha256').update('app-binary').digest('hex')}\0${Buffer.byteLength('app-binary')}\n`,
      )
      .digest('hex');
    expect(evidence.artifacts.find((item) => item.kind === 'app')?.sha256).toBe(appHash);
  });
});
