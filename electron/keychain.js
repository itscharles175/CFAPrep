import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isPathWithin } from './path-policy.js';

export const KEYCHAIN_SERVICE = 'StudyVault';
export const KEYCHAIN_ACCOUNT = 'secure-vault-dek';

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

class EncryptedSecretFile {
  constructor({ safeStorage, userDataPath, recordName, platform = process.platform }) {
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.userDataPath = userDataPath;
    this.directory = path.join(userDataPath, 'secure-key-storage');
    this.recordName = recordName;
    this.filePath = path.join(this.directory, `${recordName}.bin`);
  }

  #assertAvailable() {
    assertSafeStorageAvailable(this.safeStorage, this.platform);
  }

  async set(secret) {
    this.#assertAvailable();
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 8192) {
      throw new Error('Keychain secret must be between 1 and 8192 characters');
    }
    const encrypted = this.safeStorage.encryptString(secret);
    if (!(encrypted instanceof Uint8Array) || encrypted.byteLength === 0) {
      throw new Error('safeStorage did not return encrypted data');
    }

    await this.#prepareDirectory(true);
    await this.#rejectSymlinkIfPresent();
    const temporary = path.join(this.directory, `.${this.recordName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      if (this.platform === 'win32') await rm(this.filePath, { force: true });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get() {
    this.#assertAvailable();
    if (!(await this.#prepareDirectory(false))) return null;
    const exists = await this.#rejectSymlinkIfPresent();
    if (!exists) return null;
    const encrypted = await readFile(this.filePath);
    if (encrypted.byteLength === 0) throw new Error('Encrypted keychain record is empty');
    return this.safeStorage.decryptString(encrypted);
  }

  async delete() {
    this.#assertAvailable();
    if (!(await this.#prepareDirectory(false))) return;
    await this.#rejectSymlinkIfPresent();
    await rm(this.filePath, { force: true });
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
    this.record = new EncryptedSecretFile({ ...options, recordName: 'lsat-db-dek' });
    this.filePath = this.record.filePath;
  }

  async getOrCreate() {
    const existing = await this.record.get();
    if (existing !== null) return validateLsatDbKey(existing);
    const generated = randomBytes(32).toString('base64');
    await this.record.set(generated);
    return generated;
  }
}
