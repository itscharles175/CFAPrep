#!/usr/bin/env node
/*
 * Smoke-test a frozen sidecar binary (Plan P4).
 *
 * Boots the PyInstaller-built backend on a throwaway port, polls its health
 * endpoint until it answers (or a timeout elapses), then kills it. This is the
 * cheapest catch for the failure mode PyInstaller is prone to: a binary that
 * *builds* fine but dies at boot with a runtime `ModuleNotFoundError` (a missed
 * hidden-import) or a frozen-only import error. `tauri build` happily bundles
 * such a binary; only actually running it surfaces the break.
 *
 * Usage:
 *   node scripts/smoke-sidecar.mjs \
 *     --bin src-tauri/resources/services/lsat-backend/lsatlab-backend \
 *     --url http://127.0.0.1:8123/api/health \
 *     --expect-ok --timeout 60000 \
 *     -- --host 127.0.0.1 --port 8123
 *
 * Everything after `--` is forwarded verbatim to the binary. On Windows a
 * missing `--bin` is retried with a `.exe` suffix. Exit 0 = healthy, 1 = not.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

function parseArgs(argv) {
  const out = { healthExpectOk: false, timeout: 60000, interval: 1000, child: [] };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === '--') { out.child = rest.splice(0); break; }
    else if (a === '--bin') out.bin = rest.shift();
    else if (a === '--url') out.url = rest.shift();
    else if (a === '--expect-ok') out.healthExpectOk = true;
    else if (a === '--timeout') out.timeout = Number(rest.shift());
    else if (a === '--interval') out.interval = Number(rest.shift());
    else if (a === '--label') out.label = rest.shift();
    else { console.error(`smoke-sidecar: unknown arg ${a}`); process.exit(2); }
  }
  if (!out.bin || !out.url) {
    console.error('smoke-sidecar: --bin and --url are required.');
    process.exit(2);
  }
  return out;
}

function resolveBin(bin) {
  if (existsSync(bin) && statSync(bin).size > 0) return bin;
  if (process.platform === 'win32' && existsSync(`${bin}.exe`)) return `${bin}.exe`;
  console.error(`smoke-sidecar: binary not found or empty: ${bin}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, expectOk) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    if (!expectOk) return { ok: true, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return body && body.ok === true
      ? { ok: true, detail: 'ok:true' }
      : { ok: false, detail: `body=${JSON.stringify(body)}` };
  } catch (e) {
    return { ok: false, detail: e.code || e.name || String(e) };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bin = resolveBin(opts.bin);
  const label = opts.label || bin.split(/[/\\]/).pop();

  console.log(`smoke-sidecar[${label}]: spawning ${bin} ${opts.child.join(' ')}`);
  const child = spawn(bin, opts.child, { windowsHide: true });

  // Buffer the tail of stderr/stdout so a boot failure is diagnosable.
  let logTail = '';
  const capture = (buf) => { logTail = (logTail + buf.toString()).slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  const deadline = Date.now() + opts.timeout;
  let result = { ok: false, detail: 'timed out before first probe' };
  while (Date.now() < deadline) {
    if (exited) {
      console.error(`smoke-sidecar[${label}]: process exited early (code=${exited.code} sig=${exited.sig})`);
      if (logTail) console.error(`--- output tail ---\n${logTail}`);
      process.exit(1);
    }
    result = await probe(opts.url, opts.healthExpectOk);
    if (result.ok) {
      console.log(`smoke-sidecar[${label}]: healthy (${result.detail}) at ${opts.url}`);
      child.kill();
      // Give it a moment to release the port/handles in CI.
      await sleep(250);
      process.exit(0);
    }
    await sleep(opts.interval);
  }

  console.error(`smoke-sidecar[${label}]: FAILED — ${opts.url} never became healthy (last: ${result.detail})`);
  if (logTail) console.error(`--- output tail ---\n${logTail}`);
  child.kill();
  process.exit(1);
}

main();
