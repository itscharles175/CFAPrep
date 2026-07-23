import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isPathWithin } from './path-policy.js';
import { isNonEmptyLsatStore, lsatStorePath, resolveLsatDataDir } from './relocation.js';

export const KEYCHAIN_SERVICE = 'StudyVault';
export const KEYCHAIN_ACCOUNT = 'secure-vault-dek';
export const LSAT_DB_RECORD = 'lsat-db-dek';

// The Tauri build custodied both secrets in the OS credential store under
// `{service}/{account}` generic targets (`src-tauri/src/keychain.rs`). Electron
// keeps them in safeStorage-encrypted files instead, so an upgrading install has
// to import the old value once or its already-encrypted data is stranded.
const LEGACY_CREDENTIAL_SERVICE = 'studyvault';
const LEGACY_CREDENTIAL_ACCOUNTS = Object.freeze({
  [KEYCHAIN_ACCOUNT]: 'vault-dek',
  [LSAT_DB_RECORD]: 'lsat-db-dek',
});
const LEGACY_LOOKUP_TIMEOUT_MS = 10_000;

// Records written before name binding stored the bare secret; version 1 wraps it
// so a record's ciphertext cannot be swapped in for another record's file.
const RECORD_ENVELOPE_VERSION = 1;

export function assertKeychainTarget(service, account) {
  if (service !== KEYCHAIN_SERVICE || account !== KEYCHAIN_ACCOUNT) {
    throw new Error('Keychain access is restricted to StudyVault/secure-vault-dek');
  }
}

export function assertSafeStorageAvailable(safeStorage, platform = process.platform) {
  if (!safeStorage || safeStorage.isEncryptionAvailable() !== true) {
    throw new Error('OS-backed safeStorage encryption is unavailable');
  }
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (!backend || backend === 'basic_text') {
      throw new Error('Linux safeStorage basic-text fallback is not permitted');
    }
  }
}

export function encodeRecordPayload(recordName, secret) {
  return JSON.stringify({ v: RECORD_ENVELOPE_VERSION, name: recordName, secret });
}

export function decodeRecordPayload(recordName, plaintext) {
  let envelope;
  try {
    envelope = JSON.parse(plaintext);
  } catch {
    return { secret: plaintext, bound: false };
  }
  if (!envelope || typeof envelope !== 'object' || envelope.v !== RECORD_ENVELOPE_VERSION) {
    return { secret: plaintext, bound: false };
  }
  if (envelope.name !== recordName) {
    throw new Error(`Encrypted keychain record ${recordName} is bound to a different record`);
  }
  if (typeof envelope.secret !== 'string' || envelope.secret.length === 0) {
    throw new Error(`Encrypted keychain record ${recordName} carries no secret`);
  }
  return { secret: envelope.secret, bound: true };
}

function runLegacyLookup(file, args, extraEnv = null) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: LEGACY_LOOKUP_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

// `cmdkey` can only prove a target EXISTS — it never prints the blob — so it is
// the cheap gate that keeps the compile-and-P/Invoke read below off the
// fresh-install path.
const WINDOWS_CREDENTIAL_READER = `$source = @'
using System;
using System.Runtime.InteropServices;
public static class SvLegacyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr handle;
    if (!CredReadW(target, 1, 0, out handle)) return null;
    try {
      CREDENTIAL record = (CREDENTIAL)Marshal.PtrToStructure(handle, typeof(CREDENTIAL));
      if (record.CredentialBlobSize == 0) return null;
      byte[] blob = new byte[record.CredentialBlobSize];
      Marshal.Copy(record.CredentialBlob, blob, 0, (int)record.CredentialBlobSize);
      return System.Text.Encoding.UTF8.GetString(blob);
    } finally { CredFree(handle); }
  }
}
'@
Add-Type -TypeDefinition $source
$value = [SvLegacyCredential]::Read($env:SV_LEGACY_TARGET)
if ($value) { [Console]::Out.Write($value) }`;

export function readLegacyCredential({ account, platform = process.platform, runCommand = runLegacyLookup }) {
  if (!Object.values(LEGACY_CREDENTIAL_ACCOUNTS).includes(account)) return null;
  const target = `${LEGACY_CREDENTIAL_SERVICE}/${account}`;
  if (platform === 'win32') {
    const listed = runCommand('cmdkey', [`/list:${target}`]);
    if (listed.status !== 0 || !listed.stdout.includes(target)) return null;
    const read = runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CREDENTIAL_READER],
      { SV_LEGACY_TARGET: target },
    );
    if (read.status !== 0) return null;
    return read.stdout.length > 0 ? read.stdout : null;
  }
  if (platform === 'darwin') {
    const read = runCommand('security', ['find-generic-password', '-s', target, '-w']);
    if (read.status !== 0) return null;
    const value = read.stdout.trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

class EncryptedSecretFile {
  constructor({
    safeStorage,
    userDataPath,
    recordName,
    platform = process.platform,
    readLegacy = readLegacyCredential,
  }) {
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.userDataPath = userDataPath;
    this.directory = path.join(userDataPath, 'secure-key-storage');
    this.recordName = recordName;
    this.filePath = path.join(this.directory, `${recordName}.bin`);
    this.importMarkerPath = path.join(this.directory, `.${recordName}.legacy-import`);
    this.readLegacy = readLegacy;
  }

  #assertAvailable() {
    assertSafeStorageAvailable(this.safeStorage, this.platform);
  }

  async set(secret) {
    this.#assertAvailable();
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 8192) {
      throw new Error('Keychain secret must be between 1 and 8192 characters');
    }
    const encrypted = this.safeStorage.encryptString(encodeRecordPayload(this.recordName, secret));
    if (!(encrypted instanceof Uint8Array) || encrypted.byteLength === 0) {
      throw new Error('safeStorage did not return encrypted data');
    }

    await this.#prepareDirectory(true);
    await this.#rejectSymlinkIfPresent();
    const temporary = path.join(this.directory, `.${this.recordName}.${randomUUID()}.tmp`);
    try {
      // The record is the only copy of a key that already encrypts user data, so
      // the bytes must reach the platter before the rename publishes them: a
      // crash between a buffered write and the rename would leave an empty or
      // absent record and strand the database it protects.
      const handle = await open(temporary, 'wx', 0o600);
      try {
        const { bytesWritten } = await handle.write(encrypted);
        if (bytesWritten !== encrypted.byteLength) {
          throw new Error('Encrypted keychain record was written incompletely');
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#publish(temporary);
      await this.#syncDirectory();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get() {
    this.#assertAvailable();
    if (!(await this.#prepareDirectory(false))) return this.#importLegacySecretOnce();
    const exists = await this.#rejectSymlinkIfPresent();
    if (!exists) return this.#importLegacySecretOnce();
    const encrypted = await readFile(this.filePath);
    if (encrypted.byteLength === 0) throw new Error('Encrypted keychain record is empty');
    const { secret, bound } = decodeRecordPayload(this.recordName, this.safeStorage.decryptString(encrypted));
    // Upgrading an unbound record is best-effort: refusing the read instead
    // would strand data that the record still legitimately protects.
    if (!bound) await this.set(secret).catch(() => {});
    return secret;
  }

  async delete() {
    this.#assertAvailable();
    if (!(await this.#prepareDirectory(false))) return;
    await this.#rejectSymlinkIfPresent();
    await rm(this.filePath, { force: true });
    // A delete is authoritative: without this marker the next read would import
    // the legacy credential back over the deletion.
    await this.#markLegacyImportAttempted();
  }

  // One-shot: the marker is written once an attempt COMPLETES, so an absent
  // legacy credential is not re-probed on every launch and a later delete() is
  // never undone. A failed attempt leaves no marker and is retried.
  async #importLegacySecretOnce() {
    const account = LEGACY_CREDENTIAL_ACCOUNTS[this.recordName];
    if (!account) return null;
    if (await this.#legacyImportAttempted()) return null;
    let legacy;
    try {
      legacy = this.readLegacy({ account, platform: this.platform });
    } catch {
      // The OS credential store is best-effort: a failed probe and an absent
      // credential are the same answer, and neither is worth a launch failure.
      return null;
    }
    if (typeof legacy !== 'string' || legacy.length === 0) {
      await this.#markLegacyImportAttempted();
      return null;
    }
    await this.set(legacy);
    await this.#markLegacyImportAttempted();
    return legacy;
  }

  async #legacyImportAttempted() {
    try {
      await lstat(this.importMarkerPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #markLegacyImportAttempted() {
    await this.#prepareDirectory(true);
    await writeFile(this.importMarkerPath, '', { mode: 0o600 }).catch(() => {});
  }

  // rename replaces an existing target on every supported platform, so the record
  // is never momentarily missing. Only a locked target (Windows AV scanners hold
  // brief handles) falls back to unlink-then-rename, and only that path has a
  // window in which no record exists.
  async #publish(temporary) {
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      if (this.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await rm(this.filePath, { force: true });
      await rename(temporary, this.filePath);
    }
  }

  async #syncDirectory() {
    // POSIX only: a rename is not durable until the containing directory entry is
    // flushed too. Windows exposes no directory handle to fsync.
    if (this.platform === 'win32') return;
    let handle = null;
    try {
      handle = await open(this.directory, 'r');
      await handle.sync();
    } catch {
      // Some filesystems refuse a directory fsync; the record's own fsync still
      // bounds the loss window.
    } finally {
      await handle?.close();
    }
  }

  async #rejectSymlinkIfPresent() {
    try {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error('Keychain record is not a regular file');
      }
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #prepareDirectory(create) {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let info;
    try {
      info = await lstat(this.directory);
    } catch (error) {
      if (error?.code === 'ENOENT' && !create) return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Keychain directory is not a regular directory');
    }
    const canonicalRoot = await realpath(this.userDataPath);
    const canonicalDirectory = await realpath(this.directory);
    if (!isPathWithin(canonicalRoot, canonicalDirectory)) {
      throw new Error('Keychain directory escaped userData');
    }
    return true;
  }
}

export class SecureKeyStore {
  constructor(options) {
    this.record = new EncryptedSecretFile({ ...options, recordName: KEYCHAIN_ACCOUNT });
    this.filePath = this.record.filePath;
  }

  async set(service, account, secret) {
    assertKeychainTarget(service, account);
    await this.record.set(secret);
  }

  async get(service, account) {
    assertKeychainTarget(service, account);
    return this.record.get();
  }

  async delete(service, account) {
    assertKeychainTarget(service, account);
    await this.record.delete();
  }
}

function validateLsatDbKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('Stored LSAT DB key is not a 32-byte base64 value');
  }
  return value;
}

export class LsatDbKeyStore {
  constructor(options) {
    this.record = new EncryptedSecretFile({ ...options, recordName: LSAT_DB_RECORD });
    this.filePath = this.record.filePath;
    this.userDataPath = options.userDataPath;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.statFile = options.statFile;
  }

  async getOrCreate() {
    const existing = await this.record.get();
    if (existing !== null) return validateLsatDbKey(existing);
    // Minting a key while a protected database already exists silently rotates
    // it: the backend keeps the file but can no longer decrypt a single stored
    // row. Refuse, with a reason the operator can act on.
    const stranded = this.protectedStorePath();
    if (stranded) {
      throw new Error(
        `refusing to mint a replacement key while ${stranded} exists — its encrypted rows would be ` +
          `unrecoverable. Restore ${this.filePath} from a backup, or move that database aside to start over`,
      );
    }
    const generated = randomBytes(32).toString('base64');
    await this.record.set(generated);
    return generated;
  }

  protectedStorePath() {
    const { dataDir } = resolveLsatDataDir({
      userDataPath: this.userDataPath,
      platform: this.platform,
      env: this.env,
      ...(this.statFile ? { statFile: this.statFile } : {}),
    });
    return isNonEmptyLsatStore(dataDir, this.statFile) ? lsatStorePath(dataDir) : null;
  }
}
