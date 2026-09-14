'use strict';

const CHANNELS = Object.freeze({
  RUNTIME_INFO: 'studyvault:runtime:info',
  FILES_PICK_FOLDER: 'studyvault:files:pick-folder',
  FILES_PICK_FILES: 'studyvault:files:pick-files',
  FILES_LIST_PDFS: 'studyvault:files:list-pdfs',
  FILES_READ: 'studyvault:files:read',
  FILES_AUTHORIZE_DROP: 'studyvault:files:authorize-drop',
  SIDECAR_STATUS: 'studyvault:sidecar:status',
  SIDECAR_LOGS: 'studyvault:sidecar:logs',
  SIDECAR_AGGREGATE: 'studyvault:sidecar:aggregate',
  KEYCHAIN_SET: 'studyvault:keychain:set',
  KEYCHAIN_GET: 'studyvault:keychain:get',
  KEYCHAIN_DELETE: 'studyvault:keychain:delete',
  OPEN_PATH: 'studyvault:shell:open-path',
  OPEN_EXTERNAL: 'studyvault:shell:open-external',
  POPOUT: 'studyvault:window:popout',
  NOTIFICATION: 'studyvault:notification:show',
  FULLSCREEN_GET: 'studyvault:window:fullscreen:get',
  FULLSCREEN_SET: 'studyvault:window:fullscreen:set',
  BEFORE_QUIT_ACK: 'studyvault:lifecycle:before-quit-ack',
  MICROPHONE_LEASE: 'studyvault:permission:microphone-lease',
});

const EVENTS = Object.freeze({
  BOOT_STATUS: 'studyvault:event:boot-status',
  SECOND_INSTANCE: 'studyvault:event:second-instance',
  OPEN_FILE: 'studyvault:event:open-file',
  PDF_DROP: 'studyvault:event:pdf-drop',
  LIFECYCLE: 'studyvault:event:lifecycle',
  NATIVE_NAVIGATE: 'studyvault:event:native-navigate',
  SIDEBAR_TOGGLE: 'studyvault:event:sidebar-toggle',
  BEFORE_QUIT: 'studyvault:event:before-quit',
});

module.exports = Object.freeze({ CHANNELS, EVENTS });
