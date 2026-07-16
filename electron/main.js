import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { IPC_CHANNELS, IPC_EVENTS, validateEvent } from './contracts.js';
import { registerIpcHandlers } from './ipc.js';
import { LsatDbKeyStore, SecureKeyStore } from './keychain.js';
import { installProcessCrashCapture, JsonLogger } from './logging.js';
import { NativeFileAccess, extractLaunchFilePaths } from './path-policy.js';
import { APP_ORIGIN, installAppProtocol, registerAppScheme } from './protocol.js';
import { installLsatAuthorization } from './session-auth.js';
import { buildServiceSpecs, resolveServicesDirectory } from './service-specs.js';
import { createLsatToken, SidecarManager } from './sidecar-manager.js';
import {
  configureSessionSecurity,
  hardenWebContents,
  normalizePopoutUrl,
  validatedDevServerUrl,
} from './window-security.js';
import { OwnedChildWatchdog } from './watchdog.js';

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(electronDirectory, 'preload.cjs');
const distRoot = path.join(app.getAppPath(), 'dist');

registerAppScheme(protocol);

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
  const rendererEventQueue = [];
  const pendingOpenFiles = [];
  const popouts = new Set();
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
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
      ...overrides,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: true,
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
    const window = new BrowserWindow(browserWindowOptions());
    mainWindow = window;
    window.webContents.on('did-finish-load', flushRendererEvents);
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });
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
    const paths = await authorizeLaunchPaths(extractLaunchFilePaths(argv, cwd));
    emitEvent(IPC_EVENTS.SECOND_INSTANCE, { argv, cwd, paths });
    if (paths.length > 0) emitEvent(IPC_EVENTS.OPEN_FILE, { paths });
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
    void forwardSecondInstance([url], process.cwd());
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
      configureSessionSecurity(session.defaultSession, { devServerUrl });

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
        watchdog = await OwnedChildWatchdog.start({
          scriptPath: path.join(electronDirectory, 'child-watchdog.cjs'),
          logger,
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
      });
      sidecars = new SidecarManager({
        specs,
        servicesDirectory,
        lsatToken: token,
        logger,
        watchdog,
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
      });

      await createMainWindow();
      await forwardOpenFiles(extractLaunchFilePaths(process.argv, process.cwd()));
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
