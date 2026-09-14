import process from 'node:process';
import { BrowserWindow } from 'electron';
import { ALLOWED_INVOKE_CHANNELS, IPC_CHANNELS, IPC_EVENTS, validateRequest, validateResponse } from './contracts.js';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from './keychain.js';
import { isSafeRendererUrl } from './window-security.js';

function assertTrustedSender(event, devServerUrl) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isSafeRendererUrl(frame.url, devServerUrl)) {
    throw new Error('IPC sender is not an authorized StudyVault main frame');
  }
}

export function registerIpcHandlers({
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
}) {
  const activeNotifications = new Set();
  const handlers = new Map([
    [
      IPC_CHANNELS.RUNTIME_INFO,
      async () => ({
        app_version: app.getVersion(),
        electron_version: process.versions.electron,
        chrome_version: process.versions.chrome,
        node_version: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        is_packaged: app.isPackaged,
        native_shell: 'macos-unified',
        release_tier: 'personal',
      }),
    ],
    [
      IPC_CHANNELS.MICROPHONE_LEASE,
      async (_payload, event) => {
        if (typeof event.sender.executeJavaScript !== 'function') {
          throw new Error('Microphone activation verification is unavailable');
        }
        const userActivated = await event.sender.executeJavaScript('navigator.userActivation?.isActive === true');
        if (userActivated !== true) throw new Error('Microphone access requires an active user gesture');
        return { expiresAt: microphoneLease.grant(event.sender.id) };
      },
    ],
    [
      IPC_CHANNELS.FILES_PICK_FOLDER,
      async (_payload, event) => nativeFiles.pickFolder(BrowserWindow.fromWebContents(event.sender)),
    ],
    [
      IPC_CHANNELS.FILES_PICK_FILES,
      async (_payload, event) => nativeFiles.pickFiles(BrowserWindow.fromWebContents(event.sender)),
    ],
    [IPC_CHANNELS.FILES_LIST_PDFS, async ({ root }) => nativeFiles.authorization.listPdfs(root)],
    [IPC_CHANNELS.FILES_READ, async ({ path }) => nativeFiles.authorization.readAuthorizedFile(path)],
    [
      IPC_CHANNELS.FILES_AUTHORIZE_DROP,
      async ({ paths }) => {
        const files = await nativeFiles.authorization.authorizeDroppedPdfs(paths);
        emitEvent(IPC_EVENTS.PDF_DROP, { paths: files.map((file) => file.path) });
        return files;
      },
    ],
    [IPC_CHANNELS.SIDECAR_STATUS, async () => sidecars.getStatus()],
    [IPC_CHANNELS.SIDECAR_LOGS, async ({ name }) => sidecars.getLogs(name)],
    [IPC_CHANNELS.SIDECAR_AGGREGATE, async () => sidecars.getAggregate()],
    [
      IPC_CHANNELS.KEYCHAIN_SET,
      async ({ secret }) => {
        await keyStore.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, secret);
        return { ok: true };
      },
    ],
    [IPC_CHANNELS.KEYCHAIN_GET, async () => keyStore.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)],
    [
      IPC_CHANNELS.KEYCHAIN_DELETE,
      async () => {
        await keyStore.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        return { ok: true };
      },
    ],
    [
      IPC_CHANNELS.OPEN_PATH,
      async ({ path }) => {
        const authorized = await nativeFiles.authorization.resolveAuthorizedOpenPath(path);
        const error = await shell.openPath(authorized);
        return { opened: error === '', error };
      },
    ],
    [
      IPC_CHANNELS.OPEN_EXTERNAL,
      async ({ url }) => {
        await shell.openExternal(url);
        return { opened: true };
      },
    ],
    [IPC_CHANNELS.POPOUT, async (payload, event) => createPopout(payload, event.sender)],
    [
      IPC_CHANNELS.NOTIFICATION,
      async ({ title, body, route }) => {
        if (!Notification.isSupported()) return { shown: false };
        const notification = new Notification({ title, body, silent: false });
        activeNotifications.add(notification);
        const release = () => activeNotifications.delete(notification);
        notification.once('close', release);
        notification.once('click', () => {
          if (route) navigateNative(route, 'notification');
          release();
        });
        notification.show();
        return { shown: true };
      },
    ],
    [
      IPC_CHANNELS.FULLSCREEN_GET,
      async (_payload, event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error('No window owns the IPC sender');
        return window.isFullScreen();
      },
    ],
    [
      IPC_CHANNELS.FULLSCREEN_SET,
      async ({ value }, event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error('No window owns the IPC sender');
        window.setFullScreen(value);
        return window.isFullScreen();
      },
    ],
    [
      IPC_CHANNELS.BEFORE_QUIT_ACK,
      async ({ requestId }) => {
        acknowledgeBeforeQuit(requestId);
        return { ok: true };
      },
    ],
  ]);

  const allowed = new Set(ALLOWED_INVOKE_CHANNELS);
  if (handlers.size !== allowed.size || [...handlers.keys()].some((channel) => !allowed.has(channel))) {
    throw new Error('IPC handler map does not exactly match the stable channel allowlist');
  }

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, rawPayload) => {
      assertTrustedSender(event, devServerUrl);
      const payload = validateRequest(channel, rawPayload);
      const result = await handler(payload, event);
      return validateResponse(channel, result);
    });
  }

  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    for (const notification of activeNotifications) notification.close();
    activeNotifications.clear();
  };
}
