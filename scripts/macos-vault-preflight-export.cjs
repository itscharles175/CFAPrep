#!/usr/bin/env node
/* global process, Response */
/* Read app://studyvault IndexedDB without loading StudyVault or running Dexie migrations. */
const { app, BrowserWindow, protocol } = require('electron');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const profile = option('--profile');
const output = option('--output');
if (!profile || !output) throw new Error('--profile and --output are required');
app.setPath('userData', path.resolve(profile));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

const evaluate = String.raw`(async () => {
  async function serializable(value) {
    if (value === undefined) return { __type: 'Undefined' };
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return { __type: 'Date', value: value.toISOString() };
    if (value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { __type: 'Blob', type: value.type, size: value.size, base64: btoa(binary) };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { __type: 'Bytes', base64: btoa(binary) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(serializable));
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = await serializable(value[key]);
    return result;
  }
  const infos = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
  const databases = [];
  for (const info of infos.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (!info.name) continue;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(info.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = [];
      for (const storeName of [...database.objectStoreNames].sort()) {
        const raw = await new Promise((resolve, reject) => {
          const tx = database.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const keys = store.getAllKeys();
          const values = store.getAll();
          tx.oncomplete = () => resolve(keys.result.map((key, index) => ({ key, value: values.result[index] })));
          tx.onerror = () => reject(tx.error);
        });
        const rows = [];
        for (const row of raw) rows.push({ key: await serializable(row.key), value: await serializable(row.value) });
        stores.push({ name: storeName, rows });
      }
      databases.push({ name: info.name, version: database.version, stores });
    } finally { database.close(); }
  }
  return databases;
})()`;

app.whenReady().then(async () => {
  protocol.handle('app', () => new Response('<!doctype html><meta charset="utf-8"><title>Vault export</title>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('app://studyvault/');
    const databases = await window.webContents.executeJavaScript(evaluate, true);
    const counts = {};
    const digests = {};
    for (const database of databases) for (const store of database.stores) {
      const key = `${database.name}:${store.name}`;
      counts[key] = store.rows.length;
      digests[key] = digest(store.rows);
    }
    const payload = { schema: 'studyvault.semantic-vault-export.v1', generatedAt: new Date().toISOString(), origin: 'app://studyvault/', counts, digests, databases };
    mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    writeFileSync(path.resolve(output), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    const databaseVersions = Object.fromEntries(databases.map((database) => [database.name, database.version]));
    process.stdout.write(`${JSON.stringify({ databaseCount: databases.length, databaseVersions, storeCount: Object.keys(counts).length, counts, digests })}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`macos-vault-preflight-export: ${error.message}\n`);
  app.exit(1);
});
