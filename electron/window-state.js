import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const WINDOW_STATE_VERSION = 1;
export const WINDOW_STATE_FILE = 'window-state.json';
export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 640;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validBounds(bounds) {
  return (
    bounds &&
    finiteNumber(bounds.x) &&
    finiteNumber(bounds.y) &&
    Number.isInteger(bounds.width) &&
    Number.isInteger(bounds.height) &&
    bounds.width >= MIN_WINDOW_WIDTH &&
    bounds.height >= MIN_WINDOW_HEIGHT &&
    bounds.width <= 16_384 &&
    bounds.height <= 16_384
  );
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

export function validateWindowState(value, displays) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== WINDOW_STATE_VERSION || !validBounds(value.bounds)) return null;
  if (typeof value.maximized !== 'boolean' || typeof value.fullscreen !== 'boolean') return null;
  if (value.displayId !== null && typeof value.displayId !== 'string' && !Number.isSafeInteger(value.displayId)) return null;
  if (!Array.isArray(displays) || displays.length === 0) return null;

  const matchingDisplay = displays.find(
    (display) =>
      String(display.id) === String(value.displayId) && intersectionArea(value.bounds, display.workArea) >= 10_000,
  );
  const visibleDisplay = matchingDisplay ?? displays.find((display) => intersectionArea(value.bounds, display.workArea) >= 10_000);
  if (!visibleDisplay) return null;

  const workArea = visibleDisplay.workArea;
  const width = Math.min(value.bounds.width, workArea.width);
  const height = Math.min(value.bounds.height, workArea.height);
  const x = Math.min(Math.max(value.bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(value.bounds.y, workArea.y), workArea.y + workArea.height - height);
  return {
    version: WINDOW_STATE_VERSION,
    displayId: visibleDisplay.id,
    bounds: { x, y, width, height },
    maximized: value.maximized,
    fullscreen: value.fullscreen,
  };
}

export function readWindowState(userDataPath, displays, logger = null) {
  try {
    const raw = JSON.parse(readFileSync(path.join(userDataPath, WINDOW_STATE_FILE), 'utf8'));
    return validateWindowState(raw, displays);
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn('window_state_rejected', { error });
    return null;
  }
}

export function writeWindowState(userDataPath, state, logger = null) {
  const target = path.join(userDataPath, WINDOW_STATE_FILE);
  const temporary = `${target}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch (error) {
    logger?.warn('window_state_write_failed', { error });
    return false;
  }
}

export function captureWindowState(window, screen) {
  const bounds = window.getNormalBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    version: WINDOW_STATE_VERSION,
    displayId: display.id,
    bounds,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

export function installWindowStatePersistence(window, { userDataPath, screen, logger = null, delayMs = 250 }) {
  let timer = null;
  const persist = () => {
    if (window.isDestroyed()) return;
    writeWindowState(userDataPath, captureWindowState(window, screen), logger);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, delayMs);
  };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    window.on(event, schedule);
  }
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    persist();
  });
  return () => {
    if (timer) clearTimeout(timer);
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      window.removeListener(event, schedule);
    }
  };
}
