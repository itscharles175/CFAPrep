import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIGNING_EVIDENCE_SCHEMA,
  buildWindowsSigningConfig,
  inspectCredentialSet,
  normalizePlatform,
  normalizeThumbprint,
  validateSigningAssetBindings,
  validateSigningEvidence,
  verifyMacArtifacts,
  verifyWindowsArtifacts,
} from './release-signing.mjs';

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
    expect(inspectCredentialSet('windows', { WINDOWS_CERT_BASE64: 'x' }).missing).toContain(
      'WINDOWS_CERT_PASSWORD',
    );
    expect(inspectCredentialSet('windows', { ...WINDOWS_ENV, WINDOWS_CERT_THUMBPRINT: 'bad' }).errors).toHaveLength(1);
    expect(inspectCredentialSet('windows', WINDOWS_ENV)).toMatchObject({ complete: true, required: true });
  });

  it('requires the complete macOS signing and notarization credential set', () => {
    expect(inspectCredentialSet('macos', { ...MAC_ENV, APPLE_TEAM_ID: '' }).missing).toEqual(['APPLE_TEAM_ID']);
    expect(inspectCredentialSet('macos', MAC_ENV)).toMatchObject({ complete: true, required: true });
    expect(inspectCredentialSet('linux', {})).toMatchObject({ complete: true, required: false });
  });

  it('creates the Tauri Windows config overlay from the expected signer', () => {
    expect(buildWindowsSigningConfig(WINDOWS_ENV.WINDOWS_CERT_THUMBPRINT)).toEqual({
      bundle: { windows: { certificateThumbprint: 'A'.repeat(40) } },
    });
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
        artifact('nsis', 'bundle/nsis/StudyVault-setup.exe', true),
        artifact('msi', 'bundle/msi/StudyVault.msi', true),
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
      path: `bundle/${kind === 'app' ? 'macos/StudyVault.app' : 'dmg/StudyVault.dmg'}`,
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
          path: 'app.exe', kind: 'app', size: 10, sha256: 'a'.repeat(64), published: false,
          signed: true, verified: true, timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) }, timestamp: { thumbprint: 'D'.repeat(40) },
        },
        {
          path: 'bundle/nsis/app.exe', kind: 'nsis', size: 20, sha256: 'b'.repeat(64), published: true,
          signed: true, verified: true, timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) }, timestamp: { thumbprint: 'D'.repeat(40) },
        },
        {
          path: 'bundle/msi/app.msi', kind: 'msi', size: 30, sha256: 'c'.repeat(64), published: true,
          signed: true, verified: true, timestamped: true,
          signer: { thumbprint: 'C'.repeat(40) }, timestamp: { thumbprint: 'D'.repeat(40) },
        },
      ],
    };
    const assets = signing.artifacts.filter((item) => item.published).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    expect(validateSigningAssetBindings(signing, assets)).toEqual({ ok: true, errors: [] });
    expect(validateSigningAssetBindings(signing, assets.map((item) => ({ ...item, sha256: 'f'.repeat(64) }))).ok).toBe(false);
    expect(validateSigningAssetBindings(signing, [...assets, { ...assets[0], sha256: 'f'.repeat(64) }]).errors).toContain(
      'bundle asset paths must be present and unique',
    );
  });

  it('discovers and verifies the Windows app, NSIS, and MSI artifacts', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'bundle', 'nsis'), { recursive: true });
    await mkdir(join(root, 'bundle', 'msi'), { recursive: true });
    await writeFile(join(root, 'StudyVault.exe'), 'app');
    await writeFile(join(root, 'bundle', 'nsis', 'StudyVault-setup.exe'), 'nsis');
    await writeFile(join(root, 'bundle', 'msi', 'StudyVault.msi'), 'msi');
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
    expect(evidence.artifacts.filter((item) => item.published).map((item) => item.kind).sort()).toEqual([
      'msi',
      'nsis',
    ]);
    expect(validateSigningEvidence(evidence, { requireSigned: true }).ok).toBe(true);
  });

  it('verifies and staples the macOS app without requiring a DMG staple', async () => {
    const root = await tempDir();
    const app = join(root, 'bundle', 'macos', 'StudyVault.app');
    const appBinary = join(app, 'Contents', 'MacOS', 'StudyVault');
    const dmg = join(root, 'bundle', 'dmg', 'StudyVault.dmg');
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(root, 'bundle', 'dmg'), { recursive: true });
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
