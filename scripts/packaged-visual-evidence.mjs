import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

/* global document */

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export const PACKAGED_VISUAL_SCENARIOS = Object.freeze([
  { id: 'today-wide-light', route: '/', theme: 'light', width: 1440, height: 960, surface: 'today' },
  { id: 'today-minimum-dark', route: '/', theme: 'dark', width: 960, height: 640, surface: 'minimum-window' },
  { id: 'assessment-focus-light', route: '/cfa/level1/fixed-income/quiz', theme: 'light', width: 1440, height: 960, surface: 'focus', focus: true },
  { id: 'long-reading-dark', route: '/cfa/level1/fixed-income', theme: 'dark', width: 1440, height: 960, surface: 'reading' },
  { id: 'empty-state-light', route: '/review', theme: 'light', width: 960, height: 640, surface: 'state' },
  { id: 'offline-recovery-dark', route: '/system', theme: 'dark', width: 1440, height: 960, surface: 'unavailable-state', offline: true },
  { id: 'reduced-motion-dark', route: '/progress/overview', theme: 'dark', width: 1440, height: 960, surface: 'reduced-motion', reducedMotion: true },
  { id: 'fullscreen-light', route: '/', theme: 'light', fullscreen: true, surface: 'fullscreen' },
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (token === '--app' || token === '--output' || token === '--commit' || token === '--timeout-ms') {
      options[token.slice(2).replace('-ms', 'Ms')] = argv[++index];
    } else if (token === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/packaged-visual-evidence.mjs --app <StudyVault.app|executable> --output <directory>',
    '',
    'Launches only the supplied packaged executable with a new ephemeral --user-data-dir.',
    'It never opens the live StudyVault profile. --keep-profile preserves the synthetic profile for debugging.',
  ].join('\n');
}

export function resolvePackagedExecutable(appPath) {
  if (!appPath) throw new Error('--app is required.');
  const absolute = path.resolve(appPath);
  if (absolute.endsWith('.app')) return path.join(absolute, 'Contents', 'MacOS', 'StudyVault');
  return absolute;
}

export function resolveAppBundleRoot(appPath, executablePath = resolvePackagedExecutable(appPath)) {
  const supplied = path.resolve(appPath);
  if (supplied.endsWith('.app')) return supplied;
  let cursor = path.dirname(path.resolve(executablePath));
  while (cursor !== path.dirname(cursor)) {
    if (cursor.endsWith('.app')) return cursor;
    cursor = path.dirname(cursor);
  }
  throw new Error('The packaged executable must be inside a .app bundle.');
}

export function isUnsafeProfilePath(candidate, homeDirectory = os.homedir()) {
  const normalized = path.resolve(candidate);
  const liveCandidates = [
    path.join(homeDirectory, 'Library', 'Application Support', 'StudyVault'),
    path.join(homeDirectory, 'Library', 'Application Support', 'studyvault'),
  ].map((item) => path.resolve(item));
  return liveCandidates.includes(normalized);
}

export function sanitizeCaptureError(error) {
  const message = String(error?.stderr || error?.message || error || '').toLowerCase();
  if (/screen recording|not authorized|permission|could not create image/.test(message)) return 'screen-recording-unavailable';
  if (/window|display/.test(message)) return 'native-window-unavailable';
  return 'native-capture-failed';
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

export async function sha256BundleTree(bundleRoot) {
  const root = path.resolve(bundleRoot);
  const hash = createHash('sha256');
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }

  await visit(root);
  files.sort((left, right) => Buffer.from(path.relative(root, left)).compare(Buffer.from(path.relative(root, right))));
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const metadata = await stat(file);
    hash.update(`${relative}\0${await sha256File(file)}\0${metadata.size}\n`);
  }
  return hash.digest('hex');
}

export function buildNativeCaptureGate(captures, requiredIds = captures.map((capture) => capture.id)) {
  const byId = new Map(captures.map((capture) => [capture.id, capture]));
  const failures = requiredIds
    .map((id) => byId.get(id) || { id })
    .filter((capture) => capture.native_capture?.status !== 'captured')
    .map((capture) => ({ id: capture.id, reason: capture.native_capture?.reason || 'native-capture-missing' }));
  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    required: requiredIds.length,
    captured: requiredIds.length - failures.length,
    failures,
  };
}

async function pngMetadata(filePath) {
  const image = PNG.sync.read(await readFile(filePath));
  return { width_px: image.width, height_px: image.height };
}

async function currentCommit(fallback) {
  if (fallback) return fallback;
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() });
  return stdout.trim();
}

function relativeArtifact(outputDirectory, filePath) {
  return path.relative(outputDirectory, filePath).split(path.sep).join('/');
}

async function nativeWindowCapture(windowId, destination) {
  if (process.platform !== 'darwin') return { status: 'unavailable', reason: 'macos-required' };
  if (!Number.isInteger(windowId) || windowId <= 0) return { status: 'unavailable', reason: 'native-window-unavailable' };
  try {
    await execFileAsync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), destination]);
    const info = await stat(destination);
    if (info.size === 0) throw new Error('Native capture produced an empty image.');
    return { status: 'captured' };
  } catch (error) {
    await rm(destination, { force: true });
    return { status: 'unavailable', reason: sanitizeCaptureError(error) };
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function readDisplayInventory() {
  try {
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'macos-display-inventory.swift');
    const { stdout } = await execFileAsync('/usr/bin/xcrun', ['swift', script]);
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

function targetBounds(scenario, displays, secondary) {
  const primary = displays.find((display) => display.primary) || displays[0];
  const target = secondary ? displays.find((display) => !display.primary) : primary;
  if (!target) throw new Error('No secondary display is connected.');
  const workArea = target.work_area;
  const width = Math.min(scenario.width || 1440, workArea.width);
  const height = Math.min(scenario.height || 960, workArea.height);
  return {
    left: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    top: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
  };
}

async function configureWindow(cdp, windowId, scenario, displays, secondary = false) {
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  if (scenario.fullscreen) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  } else {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: targetBounds(scenario, displays, secondary) });
  }
  await new Promise((resolve) => setTimeout(resolve, scenario.fullscreen ? 1_200 : 350));
}

function displayForBounds(bounds, displays) {
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const index = displays.findIndex((display) => {
    const frame = display.bounds;
    return centerX >= frame.x && centerX < frame.x + frame.width && centerY >= frame.y && centerY < frame.y + frame.height;
  });
  return { index, display: displays[index] || displays.find((candidate) => candidate.primary) || displays[0] };
}

async function connectToPackagedApplication(executable, profile, timeoutMs) {
  const port = await reserveLoopbackPort();
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run'], {
    env: {
      HOME: profile,
      LANG: process.env.LANG || 'en_US.UTF-8',
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      STUDYVAULT_EVIDENCE_PROFILE: 'fresh',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + timeoutMs;
  let browser;
  while (Date.now() < deadline && !browser) {
    if (child.exitCode !== null) throw new Error(`Packaged StudyVault exited before CDP became ready (code ${child.exitCode}).`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_000 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (!browser) {
    child.kill('SIGTERM');
    throw new Error(`Packaged StudyVault did not expose its local evidence endpoint within ${timeoutMs}ms.`);
  }
  return { browser, child, exited };
}

async function closePackagedApplication(connection) {
  if (!connection) return;
  await connection.browser.close().catch(() => {});
  if (connection.child.exitCode === null) connection.child.kill('SIGTERM');
  const result = await Promise.race([
    connection.exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  if (!result && connection.child.exitCode === null) connection.child.kill('SIGKILL');
}

async function preparePage(page, scenario) {
  await page.context().setOffline(Boolean(scenario.offline));
  await page.emulateMedia({ colorScheme: scenario.theme, reducedMotion: scenario.reducedMotion ? 'reduce' : 'no-preference' });
  await page.evaluate((theme) => localStorage.setItem('qv-theme', theme), scenario.theme);
  const target = new URL(scenario.route, page.url()).toString();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(() => document.readyState === 'complete' && document.body?.innerText?.trim().length > 0, null, { timeout: DEFAULT_TIMEOUT_MS });
  await page.evaluate((theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.dataset.evidenceCapture = 'true';
  }, scenario.theme);
  await page.evaluate(() => document.fonts?.ready);
  if (scenario.focus) await page.keyboard.press('Tab');
  await page.waitForTimeout(350);
}

async function captureScenario({ cdp, windowId, page, outputDirectory, scenario, displays, secondary = false }) {
  await configureWindow(cdp, windowId, scenario, displays, secondary);
  await preparePage(page, scenario);
  const environment = await cdp.send('Browser.getWindowBounds', { windowId });
  const activeDisplay = displayForBounds(environment.bounds, displays);
  const boundsMatch = scenario.fullscreen
    ? environment.bounds.windowState === 'fullscreen'
    : environment.bounds.width === scenario.width && environment.bounds.height === scenario.height;
  if (!boundsMatch) {
    throw new Error(`Native outer bounds did not settle at the requested size for ${scenario.id}.`);
  }
  const rendererPath = path.join(outputDirectory, `${scenario.id}.renderer.png`);
  const nativePath = path.join(outputDirectory, `${scenario.id}.native.png`);
  await page.screenshot({ path: rendererPath, animations: 'disabled' });
  const nativeResult = await nativeWindowCapture(windowId, nativePath);
  const activeElement = await page.evaluate(() => {
    const node = document.activeElement;
    if (!node) return null;
    return { tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || undefined };
  });
  const renderer = {
    status: 'captured',
    file: relativeArtifact(outputDirectory, rendererPath),
    sha256: await sha256File(rendererPath),
    ...(await pngMetadata(rendererPath)),
  };
  const native = nativeResult.status === 'captured'
    ? {
        status: 'captured',
        file: relativeArtifact(outputDirectory, nativePath),
        sha256: await sha256File(nativePath),
        ...(await pngMetadata(nativePath)),
      }
    : nativeResult;
  return {
    id: scenario.id,
    route: scenario.route,
    theme: scenario.theme,
    surface: scenario.surface,
    offline: Boolean(scenario.offline),
    reduced_motion: Boolean(scenario.reducedMotion),
    fullscreen: environment.bounds.windowState === 'fullscreen',
    requested_outer_bounds: scenario.fullscreen ? null : { width: scenario.width, height: scenario.height },
    requested_bounds_match: boundsMatch,
    actual_outer_bounds: {
      x: environment.bounds.left,
      y: environment.bounds.top,
      width: environment.bounds.width,
      height: environment.bounds.height,
    },
    display: {
      index: activeDisplay.index,
      scale_factor: activeDisplay.display?.scale_factor ?? null,
      secondary,
    },
    focus: scenario.focus ? activeElement : null,
    renderer_capture: renderer,
    native_capture: native,
  };
}

export async function runPackagedVisualEvidence({ appPath, outputDirectory, commit, keepProfile = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (process.platform !== 'darwin') throw new Error('Packaged macOS visual evidence requires macOS.');
  const executable = resolvePackagedExecutable(appPath);
  const appBundle = resolveAppBundleRoot(appPath, executable);
  await access(executable);
  const resolvedExecutable = await realpath(executable);
  const output = path.resolve(outputDirectory || path.join('release-evidence', 'packaged-visual'));
  await mkdir(output, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'studyvault-visual-profile-'));
  if (isUnsafeProfilePath(profile)) throw new Error('Refusing to use the live StudyVault profile for visual evidence.');

  let connection;
  const captures = [];
  let displayInventory;
  try {
    connection = await connectToPackagedApplication(resolvedExecutable, profile, Number(timeoutMs));
    const context = connection.browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: Number(timeoutMs) });
    await page.waitForLoadState('domcontentloaded');
    const cdp = await context.newCDPSession(page);
    const window = await cdp.send('Browser.getWindowForTarget');
    displayInventory = await readDisplayInventory();
    if (displayInventory.length === 0) throw new Error('macOS display inventory is unavailable.');
    for (const scenario of PACKAGED_VISUAL_SCENARIOS) {
      captures.push(await captureScenario({ cdp, windowId: window.windowId, page, outputDirectory: output, scenario, displays: displayInventory }));
    }
    if (displayInventory.length > 1) {
      const secondaryScenario = { id: 'secondary-display-dark', route: '/', theme: 'dark', width: 1440, height: 960, surface: 'secondary-display' };
      captures.push(await captureScenario({ cdp, windowId: window.windowId, page, outputDirectory: output, scenario: secondaryScenario, displays: displayInventory, secondary: true }));
    }
  } finally {
    await closePackagedApplication(connection);
    if (!keepProfile) await rm(profile, { recursive: true, force: true });
  }

  const requiredCaptureIds = [
    ...PACKAGED_VISUAL_SCENARIOS.map((scenario) => scenario.id),
    ...(displayInventory.length > 1 ? ['secondary-display-dark'] : []),
  ];
  const nativeCaptureGate = buildNativeCaptureGate(captures, requiredCaptureIds);
  const manifest = {
    schema_version: SCHEMA_VERSION,
    kind: 'studyvault-packaged-visual-evidence',
    status: nativeCaptureGate.status,
    generated_at: new Date().toISOString(),
    commit: await currentCommit(commit),
    application: {
      executable: 'StudyVault.app/Contents/MacOS/StudyVault',
      executable_sha256: await sha256File(resolvedExecutable),
      app_tree_sha256: await sha256BundleTree(appBundle),
      app_tree_digest_algorithm: 'sha256(sorted-regular-files:relativePath\\0fileSha256\\0size\\n)',
      architecture: process.arch,
      platform: process.platform,
      packaged: true,
    },
    isolation: {
      profile: 'ephemeral-fresh',
      live_profile_touched: false,
      profile_retained: Boolean(keepProfile),
    },
    displays: displayInventory,
    secondary_display_capture: displayInventory.length > 1 ? 'captured' : 'unavailable-no-secondary-display',
    native_capture_policy: 'app-window-only',
    native_capture_gate: nativeCaptureGate,
    captures,
  };
  await writeFile(path.join(output, 'packaged-visual-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const manifest = await runPackagedVisualEvidence({
      appPath: options.app,
      outputDirectory: options.output,
      commit: options.commit,
      keepProfile: options.keepProfile,
      timeoutMs: options.timeoutMs,
    });
    process.stdout.write(`${JSON.stringify({ status: manifest.status, captures: manifest.captures.length, output: path.resolve(options.output) })}\n`);
    if (manifest.status !== 'pass') process.exitCode = 1;
  }
}
