import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMacMenuTemplate, installNativeMenus, nativeRouteFromDeepLink } from '../native-shell.js';
import { WINDOW_STATE_VERSION, readWindowState, validateWindowState, writeWindowState } from '../window-state.js';

const displays = [{ id: 7, workArea: { x: 0, y: 0, width: 1440, height: 900 } }];

test('window state rejects malformed, future, undersized, and off-screen values', () => {
  const valid = { version: WINDOW_STATE_VERSION, displayId: 7, bounds: { x: 20, y: 20, width: 1200, height: 700 }, maximized: false, fullscreen: false };
  assert.deepEqual(validateWindowState(valid, displays), valid);
  assert.equal(validateWindowState({ ...valid, version: 2 }, displays), null);
  assert.equal(validateWindowState({ ...valid, bounds: { x: 0, y: 0, width: 500, height: 500 } }, displays), null);
  assert.equal(validateWindowState({ ...valid, bounds: { x: 9000, y: 9000, width: 1000, height: 700 } }, displays), null);
  assert.equal(validateWindowState({ ...valid, maximized: 'yes' }, displays), null);
});

test('window state clamps oversized bounds and persists atomically', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studyvault-window-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { version: WINDOW_STATE_VERSION, displayId: 7, bounds: { x: -50, y: -40, width: 1800, height: 1000 }, maximized: true, fullscreen: false };
  assert.deepEqual(validateWindowState(state, displays)?.bounds, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(writeWindowState(directory, state), true);
  assert.deepEqual(readWindowState(directory, displays), validateWindowState(state, displays));
  assert.doesNotMatch(await readFile(path.join(directory, 'window-state.json'), 'utf8'), /undefined/);
  await writeFile(path.join(directory, 'window-state.json'), '{bad');
  assert.equal(readWindowState(directory, displays), null);
});

test('mac menu carries standard commands, workspace shortcuts, and no production dev actions', () => {
  const template = buildMacMenuTemplate({ app: {}, navigate() {}, openDocument() {}, toggleSidebar() {}, development: false, platform: 'darwin' });
  const appMenu = template.find((entry) => entry.label === 'StudyVault');
  assert.ok(appMenu.submenu.some((entry) => entry.role === 'about'));
  assert.ok(appMenu.submenu.some((entry) => entry.accelerator === 'CommandOrControl+,'));
  const go = template.find((entry) => entry.label === 'Go');
  assert.deepEqual(go.submenu.map((item) => item.accelerator), ['CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3', 'CommandOrControl+4', 'CommandOrControl+5', 'CommandOrControl+6']);
  const view = template.find((entry) => entry.label === 'View');
  assert.equal(view.submenu.some((item) => item.role === 'toggleDevTools'), false);
  assert.equal(template.find((entry) => entry.role === 'help').submenu[0].label, 'Diagnostics');
});

test('deep links become in-app native navigation routes', () => {
  assert.equal(nativeRouteFromDeepLink({ action: 'route', route: '/vault' }), '/vault');
  assert.equal(nativeRouteFromDeepLink({ action: 'open', route: '/review' }), '/review');
  assert.equal(nativeRouteFromDeepLink({ action: 'evil', route: '/' }), null);
});

test('Dock menu routes Today, Resume Study, and Review through the native shell', () => {
  const built = [];
  let dockMenu = null;
  const Menu = {
    buildFromTemplate(template) {
      built.push(template);
      return { template };
    },
    setApplicationMenu() {},
  };
  const app = { dock: { setMenu(menu) { dockMenu = menu; } } };
  const navigations = [];
  installNativeMenus({
    app,
    Menu,
    navigate: (...args) => navigations.push(args),
    openDocument() {},
    toggleSidebar() {},
  });
  if (process.platform === 'darwin') {
    assert.ok(dockMenu);
    assert.deepEqual(dockMenu.template.map((item) => item.label), ['Today', 'Resume Study', 'Review']);
    for (const item of dockMenu.template) item.click();
    assert.deepEqual(navigations, [
      ['/__native/workspace/today', 'dock'],
      ['/__native/resume', 'dock'],
      ['/__native/workspace/review', 'dock'],
    ]);
  } else {
    assert.equal(dockMenu, null);
  }
  assert.equal(built.length >= 1, true);
});
