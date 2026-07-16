'use strict';

/* global process, window */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channelsArgument = process.argv.find((argument) => argument.startsWith('--studyvault-ipc='));
if (!channelsArgument) throw new Error('StudyVault IPC configuration is missing');
const { CHANNELS, EVENTS } = JSON.parse(decodeURIComponent(channelsArgument.slice('--studyvault-ipc='.length)));

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = Object.freeze({
  runtime: Object.freeze({
    info: () => invoke(CHANNELS.RUNTIME_INFO),
  }),
  files: Object.freeze({
    pickFolder: () => invoke(CHANNELS.FILES_PICK_FOLDER),
    pickFiles: () => invoke(CHANNELS.FILES_PICK_FILES),
    listPdfs: (root) => invoke(CHANNELS.FILES_LIST_PDFS, { root }),
    read: (path) => invoke(CHANNELS.FILES_READ, { path }),
  }),
  sidecar: Object.freeze({
    status: () => invoke(CHANNELS.SIDECAR_STATUS),
    logs: (name) => invoke(CHANNELS.SIDECAR_LOGS, { name }),
    aggregate: () => invoke(CHANNELS.SIDECAR_AGGREGATE),
  }),
  keychain: Object.freeze({
    set: (secret) => invoke(CHANNELS.KEYCHAIN_SET, { secret }),
    get: () => invoke(CHANNELS.KEYCHAIN_GET),
    delete: () => invoke(CHANNELS.KEYCHAIN_DELETE),
  }),
  openPath: (path) => invoke(CHANNELS.OPEN_PATH, { path }),
  openExternal: (url) => invoke(CHANNELS.OPEN_EXTERNAL, { url }),
  popout: (options) => invoke(CHANNELS.POPOUT, options),
  notification: (options) => invoke(CHANNELS.NOTIFICATION, options),
  fullscreen: Object.freeze({
    get: () => invoke(CHANNELS.FULLSCREEN_GET),
    set: (value) => invoke(CHANNELS.FULLSCREEN_SET, { value }),
  }),
  events: Object.freeze({
    onBootStatus: (listener) => subscribe(EVENTS.BOOT_STATUS, listener),
    onSecondInstance: (listener) => subscribe(EVENTS.SECOND_INSTANCE, listener),
    onOpenFile: (listener) => subscribe(EVENTS.OPEN_FILE, listener),
    onPdfDrop: (listener) => subscribe(EVENTS.PDF_DROP, listener),
  }),
});

contextBridge.exposeInMainWorld('studyvault', api);

window.addEventListener(
  'drop',
  (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    const paths = files
      .map((file) => webUtils.getPathForFile(file))
      .filter((filePath) => typeof filePath === 'string' && filePath.toLocaleLowerCase('en-US').endsWith('.pdf'));
    if (paths.length === 0) return;
    void invoke(CHANNELS.FILES_AUTHORIZE_DROP, { paths }).catch(() => {});
  },
  true,
);
