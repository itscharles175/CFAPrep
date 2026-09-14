import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { IPC_CHANNELS, IPC_EVENTS, validateEvent } from './contracts.js';
import { registerIpcHandlers } from './ipc.js';
import { LsatDbKeyStore, SecureKeyStore } from './keychain.js';
import { installProcessCrashCapture, JsonLogger } from './logging.js';
import { NativeFileAccess, extractDeepLinks, extractLaunchFilePaths } from './path-policy.js';
import { APP_ORIGIN, installAppProtocol, registerAppScheme } from './protocol.js';
import { installLsatAuthorization } from './session-auth.js';
import { buildServiceSpecs, resolveServicesDirectory } from './service-specs.js';
import { createLsatToken, SidecarManager } from './sidecar-manager.js';
import { SidecarOwnershipLedger } from './sidecar-ownership.js';
import {
  configureSessionSecurity,
  hardenWebContents,
  normalizePopoutUrl,
  validatedDevServerUrl,
  MicrophonePermissionLease,
} from './window-security.js';
import { OwnedChildWatchdog } from './watchdog.js';
import { installNativeMenus, nativeRouteFromDeepLink } from './native-shell.js';
import { installWindowStatePersistence, readWindowState } from './window-state.js';

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(electronDirectory, 'preload.cjs');
const distRoot = path.join(app.getAppPath(), 'dist');

registerAppScheme(protocol);
app.setName('StudyVault');
if (app.isPackaged) app.setAsDefaultProtocolClient('studyvault');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;
  let sidecars = null;
  let nativeFiles = null;
  let removeIpcHandlers = null;
  let shutdownPromise = null;
  let allowQuit = false;
  let logger = null;
  let watchdog = null;
  let removeWindowStatePersistence = null;
  let sidebarVisible = true;
  let pendingQuitCheckpoint = null;
  const microphoneLease = new MicrophonePermissionLease();
  const rendererEventQueue = [];
  const pendingOpenFiles = [];
  const popouts = new Set();
  // Packaged builds ignore the dev-server override entirely. The dev origin is
  // trusted everywhere downstream — IPC sender checks, permission grants,
  // navigation policy — and it is served over http, so it also bypasses the
  // app:// CSP. Honouring the env var in a signed install would let anyone who
  // can set one variable load their own page with the full bridge, including
  // keychain access.
  const devServerUrl =
    !app.isPackaged && process.env.VITE_DEV_SERVER_URL
      ? validatedDevServerUrl(process.env.VITE_DEV_SERVER_URL).toString()
      : null;

  function emitEvent(channel, rawPayload) {
    const payload = validateEvent(channel, rawPayload);
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
      rendererEventQueue.push([channel, payload]);
      return;
    }
    mainWindow.webContents.send(channel, payload);
  }

  function flushRendererEvents() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    while (rendererEventQueue.length > 0) {
      const [channel, payload] = rendererEventQueue.shift();
      mainWindow.webContents.send(channel, payload);
    }
  }

  function browserWindowOptions(overrides = {}) {
    return {
      width: 1440,
      height: 960,
      minWidth: 960,
      minHeight: 640,
      show: false,
      backgroundColor: '#ffffff',
      title: 'StudyVault',
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
        : {}),
      ...overrides,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        // Offline invariant: Chromium's spellchecker fetches hunspell dictionaries
        // from Google's CDN on first use (Windows/Linux). macOS uses the OS
        // spellchecker, which needs no download. `spellcheck` defaults to true, so
        // this must stay explicit — deleting the line re-enables the egress.
        spellcheck: process.platform === 'darwin',
        devTools: !app.isPackaged,
        additionalArguments: [
          `--studyvault-ipc=${encodeURIComponent(JSON.stringify({ CHANNELS: IPC_CHANNELS, EVENTS: IPC_EVENTS }))}`,
        ],
      },
    };
  }

  async function loadStudyVaultWindow(window, targetUrl) {
    hardenWebContents(window.webContents, { devServerUrl, logger });
    window.webContents.on('render-process-gone', (_event, details) => {
      logger.crash('renderer_process_gone', details);
    });
    window.webContents.on('unresponsive', () => logger.warn('renderer_unresponsive'));
    window.once('ready-to-show', () => window.show());
    await window.loadURL(targetUrl);
  }

  async function createMainWindow() {
    const restoredState = readWindowState(app.getPath('userData'), screen.getAllDisplays(), logger);
    const window = new BrowserWindow(browserWindowOptions(restoredState?.bounds));
    mainWindow = window;
    removeWindowStatePersistence?.();
    removeWindowStatePersistence = installWindowStatePersistence(window, {
      userDataPath: app.getPath('userData'),
      screen,
      logger,
    });
    window.webContents.on('did-finish-load', flushRendererEvents);
    window.on('closed', () => {
      if (mainWindow === window) {
        removeWindowStatePersistence?.();
        removeWindowStatePersistence = null;
        mainWindow = null;
      }
    });
    if (restoredState?.maximized) window.maximize();
    if (restoredState?.fullscreen) window.setFullScreen(true);
    await loadStudyVaultWindow(window, devServerUrl ?? `${APP_ORIGIN}/`);
    return window;
  }

  async function createPopout(options, openerWebContents) {
    const owner = BrowserWindow.fromWebContents(openerWebContents);
    if (!owner) throw new Error('Popout opener is not a StudyVault window');
    const targetUrl = normalizePopoutUrl(options.route, devServerUrl);
    const window = new BrowserWindow(
      browserWindowOptions({
        parent: owner,
        width: options.width,
        height: options.height,
        minWidth: 480,
        minHeight: 360,
        title: options.title,
      }),
    );
    popouts.add(window);
    window.on('closed', () => popouts.delete(window));
    await loadStudyVaultWindow(window, targetUrl);
    return { id: window.webContents.id };
  }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function navigateNative(route, source) {
    focusMainWindow();
    emitEvent(IPC_EVENTS.NATIVE_NAVIGATE, { route, source });
  }

  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
    emitEvent(IPC_EVENTS.SIDEBAR_TOGGLE, { visible: sidebarVisible });
  }

  async function openStudyDocument() {
    if (!mainWindow || mainWindow.isDestroyed() || !nativeFiles) return;
    const files = await nativeFiles.pickFiles(mainWindow);
    if (files.length > 0) emitEvent(IPC_EVENTS.OPEN_FILE, { paths: files.map((file) => file.path) });
  }

  function acknowledgeBeforeQuit(requestId) {
    if (pendingQuitCheckpoint?.requestId === requestId) pendingQuitCheckpoint.resolve(true);
  }

  async function waitForRendererCheckpoint(timeoutMs = 2500) {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return false;
    const requestId = randomUUID();
    const acknowledged = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      pendingQuitCheckpoint = {
        requestId,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      emitEvent(IPC_EVENTS.BEFORE_QUIT, { requestId, at: Date.now() });
    });
    pendingQuitCheckpoint = null;
    logger?.[acknowledged ? 'info' : 'warn'](
      acknowledged ? 'renderer_checkpoint_acknowledged' : 'renderer_checkpoint_timeout',
      { timeout_ms: timeoutMs },
    );
    return acknowledged;
  }

  async function authorizeLaunchPaths(paths) {
    const authorized = [];
    for (const candidate of paths) {
      try {
        const [file] = await nativeFiles.authorization.authorizeLaunchFiles([candidate]);
        authorized.push(file.path);
      } catch (error) {
        logger.warn('launch_file_rejected', { path: candidate, error });
      }
    }
    return authorized;
  }

  async function forwardSecondInstance(argv, cwd) {
    focusMainWindow();
    if (!nativeFiles) {
      pendingOpenFiles.push({ type: 'second-instance', argv, cwd });
      return;
    }
    forwardDeepLinks(argv);
    const paths = await authorizeLaunchPaths(extractLaunchFilePaths(argv));
    emitEvent(IPC_EVENTS.SECOND_INSTANCE, { argv, cwd, paths });
    if (paths.length > 0) emitEvent(IPC_EVENTS.OPEN_FILE, { paths });
  }

  // Deep links carry a route, never a file. They are parsed as URLs and forwarded
  // with an empty `paths`, so nothing here can reach the launch-file authorizer.
  function forwardDeepLinks(argv) {
    const links = extractDeepLinks(argv);
    if (links.length === 0) return false;
    focusMainWindow();
    for (const link of links) {
      emitEvent(IPC_EVENTS.SECOND_INSTANCE, { argv: [link.href], cwd: '', paths: [] });
      const route = nativeRouteFromDeepLink(link);
      if (route) navigateNative(route, 'deep-link');
    }
    return true;
  }

  async function forwardOpenFiles(paths) {
    if (!nativeFiles) {
      pendingOpenFiles.push({ type: 'open-file', paths });
      return;
    }
    const authorized = await authorizeLaunchPaths(paths);
    if (authorized.length > 0) emitEvent(IPC_EVENTS.OPEN_FILE, { paths: authorized });
  }

  async function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger?.info('shutdown_started', { reason });
      await waitForRendererCheckpoint();
      removeIpcHandlers?.();
      removeIpcHandlers = null;
      await sidecars?.stopAll();
      await watchdog?.close();
      watchdog = null;
      logger?.info('shutdown_completed', { reason });
    })();
    return shutdownPromise;
  }

  app.on('second-instance', (_event, argv, cwd) => {
    void forwardSecondInstance(argv, cwd);
  });
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    void forwardOpenFiles([filePath]);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!forwardDeepLinks([url])) logger?.warn('deep_link_rejected', { url });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void shutdown('before_quit').finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
  process.once('SIGINT', () => app.quit());
  process.once('SIGTERM', () => app.quit());

  void app
    .whenReady()
    .then(async () => {
      app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
      const logsPath = app.getPath('logs');
      const crashDumpsPath = path.join(logsPath, 'crash-dumps');
      mkdirSync(crashDumpsPath, { recursive: true });
      app.setPath('crashDumps', crashDumpsPath);
      logger = new JsonLogger(logsPath);
      crashReporter.start({
        productName: 'StudyVault',
        companyName: 'StudyVault',
        uploadToServer: false,
        compress: true,
      });
      installProcessCrashCapture({ logger, shutdown });
      app.on('child-process-gone', (_event, details) => logger.crash('electron_child_process_gone', details));

      installAppProtocol({ protocol, net, distRoot, logger });
      configureSessionSecurity(session.defaultSession, { devServerUrl, microphoneLease });

      const token = createLsatToken();
      const keyStoreOptions = { safeStorage, userDataPath: app.getPath('userData') };
      const keyStore = new SecureKeyStore(keyStoreOptions);
      const lsatDbKeyStore = new LsatDbKeyStore(keyStoreOptions);
      let lsatDbKeyB64 = null;
      let lsatKeyBlockReason = null;
      try {
        lsatDbKeyB64 = await lsatDbKeyStore.getOrCreate();
      } catch (error) {
        lsatKeyBlockReason = `LSAT DB encryption key unavailable: ${error.message}`;
        logger.error('lsat_db_key_unavailable', { error });
      }

      try {
        const nativeWatchdogExecutable = path.join(
          app.isPackaged ? process.resourcesPath : path.join(electronDirectory, 'resources'),
          'bin',
          'studyvault-watchdog',
        );
        watchdog = await OwnedChildWatchdog.start({
          scriptPath: path.join(electronDirectory, 'child-watchdog.cjs'),
          logger,
          nativeExecutable: process.platform === 'darwin' ? nativeWatchdogExecutable : null,
        });
      } catch (error) {
        logger.crash('watchdog_start_failed', { error });
        watchdog = null;
      }

      const servicesDirectory = resolveServicesDirectory({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        cwd: process.cwd(),
        electronDirectory,
      });
      const specs = buildServiceSpecs({
        servicesDirectory,
        userDataPath: app.getPath('userData'),
        lsatToken: token,
        lsatDbKeyB64,
        lsatKeyBlockReason,
        isPackaged: app.isPackaged,
        logger,
      });
      sidecars = new SidecarManager({
        specs,
        servicesDirectory,
        lsatToken: token,
        logger,
        watchdog,
        ownershipLedger: new SidecarOwnershipLedger({ userDataPath: app.getPath('userData'), logger }),
      });
      watchdog?.onFailure(() => {
        logger.crash('watchdog_guard_lost');
        void sidecars.stopAll();
      });
      installLsatAuthorization(session.defaultSession, () => sidecars.getAuthorizationTokenForRequest());

      nativeFiles = new NativeFileAccess({ dialog });
      removeIpcHandlers = registerIpcHandlers({
        ipcMain,
        app,
        shell,
        Notification,
        nativeFiles,
        sidecars,
        keyStore,
        devServerUrl,
        emitEvent,
        createPopout,
        navigateNative,
        acknowledgeBeforeQuit,
        microphoneLease,
      });

      await createMainWindow();
      installNativeMenus({
        app,
        Menu,
        navigate: navigateNative,
        openDocument: () => void openStudyDocument(),
        toggleSidebar,
        development: !app.isPackaged,
      });

      let wakeRecoveryPromise = null;
      const quiesceForSleep = (state) => {
        sidecars.quiesce(state);
        emitEvent(IPC_EVENTS.LIFECYCLE, { state, at: Date.now() });
      };
      const recoverAfterWake = async (state) => {
        emitEvent(IPC_EVENTS.LIFECYCLE, { state, at: Date.now() });
        if (wakeRecoveryPromise) return wakeRecoveryPromise;
        wakeRecoveryPromise = (async () => {
          try {
            try {
              const refreshedKey = await lsatDbKeyStore.getOrCreate();
              sidecars.setLsatEncryptionKey(refreshedKey, null);
            } catch (error) {
              const reason = `LSAT DB encryption key unavailable: ${error.message}`;
              sidecars.setLsatEncryptionKey(null, reason);
              logger.error('lsat_db_key_recovery_failed', { error });
            }
            const bootStatus = await sidecars.recover(state);
            emitEvent(IPC_EVENTS.BOOT_STATUS, bootStatus);
          } catch (error) {
            logger.error('sidecar_wake_recovery_failed', { state, error });
          } finally {
            wakeRecoveryPromise = null;
          }
        })();
        return wakeRecoveryPromise;
      };
      powerMonitor.on('suspend', () => quiesceForSleep('suspend'));
      powerMonitor.on('lock-screen', () => quiesceForSleep('lock'));
      powerMonitor.on('resume', () => void recoverAfterWake('resume'));
      powerMonitor.on('unlock-screen', () => void recoverAfterWake('unlock'));
      await forwardOpenFiles(extractLaunchFilePaths(process.argv));
      // Windows delivers a deep link as an argv entry rather than via `open-url`,
      // and a cold launch has no second-instance event to carry it.
      forwardDeepLinks(process.argv);
      for (const pending of pendingOpenFiles.splice(0)) {
        if (pending.type === 'second-instance') await forwardSecondInstance(pending.argv, pending.cwd);
        else await forwardOpenFiles(pending.paths);
      }

      logger.info('runtime_ready', { services_directory: servicesDirectory, packaged: app.isPackaged });
      void sidecars
        .startAll()
        .then((bootStatus) => emitEvent(IPC_EVENTS.BOOT_STATUS, bootStatus))
        .catch((error) => {
          logger.error('sidecar_boot_failed', { error });
          emitEvent(IPC_EVENTS.BOOT_STATUS, {
            status: 'error',
            launched: 0,
            skipped: 0,
            blocked: 1,
            skipped_names: [],
            blocked_names: ['Sidecar supervisor'],
            required_down_names: ['LSAT backend'],
            degraded_reason: 'Sidecar supervisor failed during startup',
          });
        });
    })
    .catch(async (error) => {
      logger?.crash('runtime_startup_failed', { error });
      await shutdown('startup_failure');
      allowQuit = true;
      app.exit(1);
    });
}
