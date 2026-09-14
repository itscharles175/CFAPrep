import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isUnsafeProfilePath,
  buildNativeCaptureGate,
  PACKAGED_VISUAL_SCENARIOS,
  resolveAppBundleRoot,
  resolvePackagedExecutable,
  sanitizeCaptureError,
  sha256BundleTree,
} from './packaged-visual-evidence.mjs';

test('the packaged evidence matrix covers native release surfaces and both themes', () => {
  const surfaces = new Set(PACKAGED_VISUAL_SCENARIOS.map((scenario) => scenario.surface));
  assert.deepEqual(
    [...surfaces].sort(),
    ['focus', 'fullscreen', 'minimum-window', 'reading', 'reduced-motion', 'state', 'today', 'unavailable-state'].sort(),
  );
  assert.deepEqual(new Set(PACKAGED_VISUAL_SCENARIOS.map((scenario) => scenario.theme)), new Set(['light', 'dark']));
  assert(PACKAGED_VISUAL_SCENARIOS.some((scenario) => scenario.width === 1440 && scenario.height === 960));
  assert(PACKAGED_VISUAL_SCENARIOS.some((scenario) => scenario.width === 960 && scenario.height === 640));
});

test('app bundles resolve to the exact packaged executable', () => {
  assert.equal(
    resolvePackagedExecutable('/tmp/StudyVault.app'),
    '/tmp/StudyVault.app/Contents/MacOS/StudyVault',
  );
  assert.equal(resolvePackagedExecutable('/tmp/custom-executable'), '/tmp/custom-executable');
  assert.equal(
    resolveAppBundleRoot('/tmp/StudyVault.app/Contents/MacOS/StudyVault'),
    '/tmp/StudyVault.app',
  );
});

test('the signed app tree digest uses the canonical regular-file identity without the absolute root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'studyvault-tree-digest-'));
  const first = path.join(temporary, 'first.app');
  const second = path.join(temporary, 'second.app');
  try {
    for (const root of [first, second]) {
      await mkdir(path.join(root, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(path.join(root, 'Contents', 'MacOS', 'StudyVault'), 'signed-binary', { mode: 0o755 });
      await symlink('MacOS/StudyVault', path.join(root, 'Contents', 'CurrentExecutable'));
    }
    assert.equal(await sha256BundleTree(first), await sha256BundleTree(second));
    await rm(path.join(second, 'Contents', 'CurrentExecutable'));
    await symlink('missing-target-is-ignored', path.join(second, 'Contents', 'CurrentExecutable'));
    assert.equal(await sha256BundleTree(first), await sha256BundleTree(second));
    await writeFile(path.join(second, 'Contents', 'MacOS', 'StudyVault'), 'changed-signed-binary', { mode: 0o755 });
    assert.notEqual(await sha256BundleTree(first), await sha256BundleTree(second));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('native evidence passes only when every required app-window capture exists', () => {
  assert.deepEqual(buildNativeCaptureGate([
    { id: 'wide', native_capture: { status: 'captured' } },
    { id: 'minimum', native_capture: { status: 'captured' } },
  ]), { status: 'pass', required: 2, captured: 2, failures: [] });
  assert.deepEqual(buildNativeCaptureGate([
    { id: 'wide', native_capture: { status: 'captured' } },
    { id: 'minimum', native_capture: { status: 'unavailable', reason: 'screen-recording-unavailable' } },
  ]), {
    status: 'fail',
    required: 2,
    captured: 1,
    failures: [{ id: 'minimum', reason: 'screen-recording-unavailable' }],
  });
  assert.deepEqual(buildNativeCaptureGate([
    { id: 'wide', native_capture: { status: 'captured' } },
  ], ['wide', 'minimum']), {
    status: 'fail',
    required: 2,
    captured: 1,
    failures: [{ id: 'minimum', reason: 'native-capture-missing' }],
  });
});

test('the harness refuses either case spelling of the live profile', () => {
  const home = path.join(os.tmpdir(), 'visual-evidence-home');
  assert.equal(isUnsafeProfilePath(path.join(home, 'Library/Application Support/StudyVault'), home), true);
  assert.equal(isUnsafeProfilePath(path.join(home, 'Library/Application Support/studyvault'), home), true);
  assert.equal(isUnsafeProfilePath(path.join(os.tmpdir(), 'studyvault-visual-profile-safe'), home), false);
});

test('native screenshot failures are sanitized without leaking system output', () => {
  assert.equal(sanitizeCaptureError({ stderr: 'Screen recording permission denied for /Users/person' }), 'screen-recording-unavailable');
  assert.equal(sanitizeCaptureError(new Error('Window cannot be found')), 'native-window-unavailable');
  assert.equal(sanitizeCaptureError(new Error('private path /Users/person failed')), 'native-capture-failed');
});
