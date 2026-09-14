#!/usr/bin/env node
/* global indexedDB */
/** Export every IndexedDB object store through the packaged renderer. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

function parseArgs(argv) {
  const options = { cdpUrl: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cdp-url') options.cdpUrl = argv[++index];
    else if (argv[index] === '--output') options.output = resolve(argv[++index]);
    else throw new Error(`unknown semantic-export argument: ${argv[index]}`);
  }
  if (!options.cdpUrl || !options.output) throw new Error('--cdp-url and --output are required');
  return options;
}

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

async function exportDatabases(page) {
  return page.evaluate(async () => {
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
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { __type: 'Bytes', base64: btoa(binary) };
      }
      if (Array.isArray(value)) return Promise.all(value.map(serializable));
      const output = {};
      for (const key of Object.keys(value).sort()) output[key] = await serializable(value[key]);
      return output;
    }

    const infos = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    const databases = [];
    for (const info of infos.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (!info.name) continue;
      const database = await new Promise((resolveOpen, rejectOpen) => {
        const request = indexedDB.open(info.name);
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => rejectOpen(request.error || new Error(`failed to open ${info.name}`));
      });
      try {
        const stores = [];
        for (const storeName of [...database.objectStoreNames].sort()) {
          const rawRows = await new Promise((resolveRows, rejectRows) => {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();
            transaction.oncomplete = () => resolveRows(
              keysRequest.result.map((key, index) => ({ key, value: valuesRequest.result[index] })),
            );
            transaction.onerror = () => rejectRows(transaction.error || new Error(`transaction failed for ${storeName}`));
          });
          const rows = [];
          for (const row of rawRows) rows.push({ key: await serializable(row.key), value: await serializable(row.value) });
          stores.push({ name: storeName, rows });
        }
        databases.push({ name: info.name, version: database.version, stores });
      } finally {
        database.close();
      }
    }
    return databases;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.connectOverCDP(options.cdpUrl);
  const deadline = Date.now() + 15_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('app://studyvault'));
    if (!page) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!page) throw new Error('packaged renderer did not expose app://studyvault within 15 seconds');
  await page.waitForLoadState('domcontentloaded');
  const databases = await exportDatabases(page);
  const backendIntegrity = await page.evaluate(async () => {
      try {
        const response = await fetch('http://127.0.0.1:8100/api/backup/integrity');
        if (!response.ok) return { available: false, status: response.status };
        const body = await response.json();
        return {
          available: true, result: body.result, foreign_key_check: body.foreign_key_check,
          schema: body.schema, pragmas: body.pragmas, status: body.status, ready: body.ready,
        };
      } catch (error) {
        return { available: false, error: String(error?.message || error) };
      }
  });
  const counts = {};
  const digests = {};
  for (const database of databases) {
    for (const store of database.stores) {
      const key = `${database.name}:${store.name}`;
      counts[key] = store.rows.length;
      digests[key] = digest(store.rows);
    }
  }
  const payload = {
    schema: 'studyvault.semantic-vault-export.v1', generatedAt: new Date().toISOString(),
    origin: page.url(), counts, digests, backendIntegrity, databases,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  const databaseVersions = Object.fromEntries(databases.map((database) => [database.name, database.version]));
  console.log(JSON.stringify({ databaseCount: databases.length, databaseVersions, storeCount: Object.keys(counts).length, counts, digests, backendIntegrity, pageUrl: page.url() }));
  // Keep the packaged app alive for the caller's native StudyVault > Quit
  // assertion. Ending this short-lived helper closes only the CDP socket.
  process.exit(0);
}

main().catch((error) => {
  console.error(`macos-vault-semantic-export: ${error.message}`);
  process.exit(1);
});
