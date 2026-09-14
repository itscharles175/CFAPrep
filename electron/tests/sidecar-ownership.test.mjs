import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SWEEP_OUTCOMES, sweepOwnedPorts } from '../port-sweep.js';
import { SidecarOwnershipLedger } from '../sidecar-ownership.js';

const logger = { info() {}, warn() {}, error() {}, crash() {} };

test('verified cross-launch ownership reclaims a survivor while start and path mismatches remain untouched', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyvault-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const executable = path.join(bin, 'lsatlab-backend');
  const replacement = path.join(bin, 'other-backend');
  await writeFile(executable, 'trusted-binary');
  await writeFile(replacement, 'different-binary');
  let identity = { startFingerprint: 'launch-start-1', executable };
  const inspectProcess = async () => identity;
  const firstLaunch = new SidecarOwnershipLedger({ userDataPath: root, logger, inspectProcess, launchId: 'launch-a' });
  await firstLaunch.track({ pid: 4242, service: 'LSAT backend', executable });

  const nextLaunch = new SidecarOwnershipLedger({ userDataPath: root, logger, inspectProcess, launchId: 'launch-b' });
  const specs = [{ name: 'LSAT backend', program: executable }];
  const verified = await nextLaunch.verifiedPids(specs);
  assert.deepEqual(verified, [4242]);
  const killed = [];
  const sweeper = { pidsOnPort: async () => [4242], kill: async (pid) => { killed.push(pid); return true; } };
  const [reclaimed] = await sweepOwnedPorts({
    targets: [{ name: 'LSAT backend', port: 8100 }],
    sweeper,
    ownedPids: verified,
  });
  assert.equal(reclaimed.outcome, SWEEP_OUTCOMES.RECLAIMED);
  assert.deepEqual(killed, [4242]);

  identity = { startFingerprint: 'reused-pid-start', executable };
  const startMismatch = new SidecarOwnershipLedger({ userDataPath: root, logger, inspectProcess, launchId: 'launch-c' });
  assert.deepEqual(await startMismatch.verifiedPids(specs), []);

  identity = { startFingerprint: 'launch-start-1', executable: replacement };
  const pathMismatch = new SidecarOwnershipLedger({ userDataPath: root, logger, inspectProcess, launchId: 'launch-d' });
  assert.deepEqual(await pathMismatch.verifiedPids(specs), []);
  const [refused] = await sweepOwnedPorts({
    targets: [{ name: 'LSAT backend', port: 8100 }],
    sweeper,
    ownedPids: [],
  });
  assert.equal(refused.outcome, SWEEP_OUTCOMES.UNIDENTIFIED);
  assert.deepEqual(killed, [4242]);
});
