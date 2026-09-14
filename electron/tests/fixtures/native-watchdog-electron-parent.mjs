import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { OwnedChildWatchdog } from '../../watchdog.js';

const logger = { info() {}, warn() {}, error() {}, crash() {} };
const watchdog = await OwnedChildWatchdog.start({
  nativeExecutable: process.env.STUDYVAULT_NATIVE_WATCHDOG,
  logger,
});
const sidecar = spawn(process.env.STUDYVAULT_NODE_BINARY, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
});
await once(sidecar, 'spawn');
await watchdog.track(sidecar.pid);
process.stdout.write(`${JSON.stringify({
  ready: true,
  watchdogPid: watchdog.child.pid,
  sidecarPid: sidecar.pid,
})}\n`);
setInterval(() => {}, 1000);
