/*
 * GAP-SEC-1 — opt-in encryption-at-rest for the LIVE vault.
 *
 * The whole threat model is local disk access: the live IndexedDB vault (and the
 * SurrealDB sidecar DB) sit in plaintext on disk, while the app already encrypts
 * only the EXPORTED backup blob (`encryptedBackup.ts`). This module adds an
 * OPT-IN "secure vault" mode that encrypts data at rest with a 256-bit
 * data-encryption-key (DEK) whose CUSTODY is Electron safeStorage via the preload
 * bridge. Only safeStorage ciphertext is persisted; the raw key is never written
 * unprotected or escrowed anywhere.
 *
 * Design:
 *  - The DEK is a random 256-bit AES-GCM key (NOT passphrase-derived - there is
 *    no human secret to stretch; safeStorage is the trust anchor). Enabling
 *    secure vault generates it once and hands it to the preload bridge.
 *  - On launch the DEK is fetched through the bridge into memory ("unlock"); on
 *    lock it is dropped from memory. Values are encrypted/decrypted with the
 *    in-memory DEK using AES-GCM with a fresh 12-byte IV per encryption.
 *  - Opt-in, not default: the per-record crypto adds cost to the RAG/index hot
 *    paths, so it's a deliberate "secure vault" toggle.
 *
 * SCOPE / runtime-gating: this module is the host-side mechanism — the DEK
 * lifecycle, the AES-GCM primitive, and the keychain bridge — and is fully
 * unit-tested with an injected in-memory key store. The OS-keychain custody
 * (`electronKeychainKeyStore`) only works inside the packaged desktop shell, so it
 * is runtime-verify-gated. Applying {@link SecureVault.encrypt}/`decrypt` to
 * every live row (transparent at-rest encryption of the whole IndexedDB) is the
 * remaining integration step, gated behind {@link SecureVault.isUnlocked} so the
 * default (disabled) path is byte-for-byte unchanged.
 */

import { getDesktopBridge, isElectronRuntime } from './desktopBridge';

const ENABLED_FLAG_KEY = 'qv-secure-vault-enabled';
const DEK_BYTES = 32; // 256-bit
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// Web Crypto helpers (mirrors encryptedBackup.ts; self-contained on purpose).
// ---------------------------------------------------------------------------

function requireCryptoSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is required for the secure vault.');
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** A single encrypted value: AES-GCM IV + ciphertext, both base64. */
export interface SecureCipher {
  v: 1;
  iv: string;
  ct: string;
}

/** Generate a fresh random 256-bit DEK, returned as base64. */
export function generateDekBase64(): string {
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(DEK_BYTES)));
}

async function importDek(dekBase64: string): Promise<CryptoKey> {
  const subtle = requireCryptoSubtle();
  const raw = base64ToBytes(dekBase64);
  // Enforce the FULL 256-bit key length. WebCrypto's raw AES-GCM import also
  // accepts 16- and 24-byte keys (AES-128/192), so a truncated / corrupt keychain
  // blob that happens to be valid base64 of a shorter length would otherwise
  // import cleanly and silently DOWNGRADE the vault below the promised 256-bit
  // strength. Reject anything that isn't exactly DEK_BYTES so unlock()'s
  // validation (and every encrypt/decrypt) pins AES-256.
  if (raw.length !== DEK_BYTES) {
    throw new Error('secure vault: key must be ' + DEK_BYTES * 8 + '-bit (' + DEK_BYTES + ' bytes)');
  }
  return subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a UTF-8 string with the raw DEK (fresh IV per call). */
export async function encryptWithDek(plaintext: string, dekBase64: string): Promise<SecureCipher> {
  const subtle = requireCryptoSubtle();
  const key = await importDek(dekBase64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new TextEncoder().encode(plaintext)),
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

/**
 * Decrypt a {@link SecureCipher} with the raw DEK.
 * @throws Error on a GCM tag mismatch (wrong key or tampered data).
 */
export async function decryptWithDek(cipher: SecureCipher, dekBase64: string): Promise<string> {
  const subtle = requireCryptoSubtle();
  const key = await importDek(dekBase64);
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBytes(cipher.iv)) },
      key,
      new Uint8Array(base64ToBytes(cipher.ct)),
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('secure vault: could not decrypt (wrong key or tampered data)');
  }
}

// ---------------------------------------------------------------------------
// Key custody - the raw DEK is persisted only as safeStorage ciphertext.
// ---------------------------------------------------------------------------

/** Custodian of the raw DEK. Production storage is main-process safeStorage. */
export interface SecureKeyStore {
  /** Whether this store can be used here (the OS keychain needs the desktop shell). */
  isAvailable(): Promise<boolean>;
  /** Read the stored DEK (base64), or null if none is set. */
  get(): Promise<string | null>;
  /** Store the DEK (base64). */
  set(dekBase64: string): Promise<void>;
  /** Remove the stored DEK. */
  clear(): Promise<void>;
}

export function isElectron(): boolean {
  return isElectronRuntime();
}

/**
 * Synchronous platform diagnostic retained for existing consumers and tests.
 * Secure-vault availability no longer depends on this check because Electron
 * safeStorage is exposed cross-platform by the main process.
 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData && typeof uaData.platform === 'string') return /win/i.test(uaData.platform);
  return /win/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * The production key store: Electron safeStorage, reached only through the
 * constrained preload bridge. The DEK remains in renderer memory only after a
 * bridge read and is never persisted by renderer storage or Web Crypto.
 */
export const electronKeychainKeyStore: SecureKeyStore = {
  async isAvailable(): Promise<boolean> {
    return getDesktopBridge() !== null;
  },
  async get(): Promise<string | null> {
    const bridge = getDesktopBridge();
    if (!bridge) return null;
    const value = await bridge.keychain.get();
    return value ?? null;
  },
  async set(dekBase64: string): Promise<void> {
    const bridge = getDesktopBridge();
    if (!bridge) throw new Error('The OS keychain is only available in the desktop app.');
    await bridge.keychain.set(dekBase64);
  },
  async clear(): Promise<void> {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    await bridge.keychain.delete();
  },
};

/**
 * An ephemeral in-memory key store. Used by tests; also the only store available
 * in browser dev (where there is NO OS keychain), so secure vault cannot persist
 * a key across reloads there — which is correct: the security guarantee requires
 * the OS keychain, so the feature is desktop-only.
 */
export function createMemoryKeyStore(): SecureKeyStore {
  let dek: string | null = null;
  return {
    async isAvailable() {
      return true;
    },
    async get() {
      return dek;
    },
    async set(value) {
      dek = value;
    },
    async clear() {
      dek = null;
    },
  };
}

/** The opt-in enabled flag — bootstrap-critical, so it lives in localStorage. */
export interface SecureVaultFlagStore {
  get(): boolean;
  set(enabled: boolean): void;
}

const localStorageFlagStore: SecureVaultFlagStore = {
  get(): boolean {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(ENABLED_FLAG_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(enabled: boolean): void {
    try {
      if (typeof localStorage === 'undefined') return;
      if (enabled) localStorage.setItem(ENABLED_FLAG_KEY, '1');
      else localStorage.removeItem(ENABLED_FLAG_KEY);
    } catch {
      /* private-mode / quota — the flag just won't persist */
    }
  },
};

// ---------------------------------------------------------------------------
// SecureVault controller — DEK lifecycle (enable / unlock / lock / disable).
// ---------------------------------------------------------------------------

export interface SecureVaultResult {
  ok: boolean;
  error?: string;
}

export class SecureVault {
  /** The DEK held in memory while unlocked; null when locked. */
  private dek: string | null = null;

  constructor(
    private readonly store: SecureKeyStore = electronKeychainKeyStore,
    private readonly flag: SecureVaultFlagStore = localStorageFlagStore,
  ) {}

  /** Whether the user has opted into the secure vault. */
  isEnabled(): boolean {
    return this.flag.get();
  }

  /** Whether the DEK is currently in memory (data can be en/decrypted). */
  isUnlocked(): boolean {
    return this.dek !== null;
  }

  /** Whether the key store (OS keychain) is usable in this environment. */
  isAvailable(): Promise<boolean> {
    return this.store.isAvailable();
  }

  /**
   * Turn ON the secure vault: generate a DEK, store it in the OS keychain, mark
   * enabled, and hold the DEK in memory (unlocked). No-op-safe if already
   * enabled. Fails (without changing state) when the OS keychain is unavailable.
   */
  async enable(): Promise<SecureVaultResult> {
    if (!(await this.store.isAvailable())) {
      return {
        ok: false,
        error: 'The OS keychain is only available in the desktop app, so the secure vault can’t be enabled here.',
      };
    }
    if (this.isEnabled()) {
      // Already enabled — make sure we're unlocked (idempotent).
      return this.unlock();
    }
    const dek = generateDekBase64();
    try {
      await this.store.set(dek);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not store the key in the OS keychain: ${msg}` };
    }
    this.dek = dek;
    this.flag.set(true);
    return { ok: true };
  }

  /**
   * Unlock the vault by loading the DEK from the OS keychain into memory. Called
   * on launch. Fails if the vault isn't enabled or the key is missing/unreadable.
   */
  async unlock(): Promise<SecureVaultResult> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'The secure vault is not enabled.' };
    }
    let dek: string | null;
    try {
      dek = await this.store.get();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not read the key from the OS keychain: ${msg}` };
    }
    if (!dek) {
      return { ok: false, error: 'No key found in the OS keychain (was it cleared outside the app?).' };
    }
    // Validate the stored value is actually a usable AES-GCM key BEFORE committing
    // to it. A corrupt / wrong-length / rotated keychain entry fails here with a
    // clear message rather than deferring an opaque WebCrypto throw to the first
    // encrypt/decrypt call (and reporting unlocked=true in the meantime).
    try {
      await importDek(dek);
    } catch {
      return { ok: false, error: 'The stored key is not a valid encryption key (corrupt or rotated?).' };
    }
    this.dek = dek;
    return { ok: true };
  }

  /** Drop the DEK from memory. Encrypt/decrypt will throw until unlocked again. */
  lock(): void {
    this.dek = null;
  }

  /**
   * Turn OFF the secure vault: remove the DEK from the keychain, clear the flag,
   * and lock.
   *
   * IMPORTANT (runtime follow-up): the caller MUST decrypt any at-rest ciphertext
   * back to plaintext BEFORE calling this — once the key is gone, encrypted rows
   * are unrecoverable. This method only tears down key custody.
   */
  async disable(): Promise<SecureVaultResult> {
    try {
      await this.store.clear();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not remove the key from the OS keychain: ${msg}` };
    }
    this.dek = null;
    this.flag.set(false);
    return { ok: true };
  }

  /** Encrypt a value with the in-memory DEK. @throws if locked. */
  async encrypt(plaintext: string): Promise<SecureCipher> {
    if (!this.dek) throw new Error('The secure vault is locked.');
    return encryptWithDek(plaintext, this.dek);
  }

  /** Decrypt a value with the in-memory DEK. @throws if locked or on tag mismatch. */
  async decrypt(cipher: SecureCipher): Promise<string> {
    if (!this.dek) throw new Error('The secure vault is locked.');
    return decryptWithDek(cipher, this.dek);
  }
}

/** App-wide singleton (OS-keychain backed). */
export const secureVault = new SecureVault();

/** Read-only status for the settings / health UI. */
export interface SecureVaultStatus {
  enabled: boolean;
  unlocked: boolean;
  available: boolean;
}

export async function getSecureVaultStatus(vault: SecureVault = secureVault): Promise<SecureVaultStatus> {
  return {
    enabled: vault.isEnabled(),
    unlocked: vault.isUnlocked(),
    available: await vault.isAvailable(),
  };
}

/** Default ceiling for an unlock-on-launch keychain read (ms). */
export const UNLOCK_LAUNCH_TIMEOUT_MS = 4000;

/**
 * Unlock-on-launch: if the secure vault is enabled, load its DEK from the OS
 * keychain so subsequent reads/writes can decrypt/encrypt. Never throws — a
 * failed unlock is surfaced so the boot path can warn rather than crash. A no-op
 * (returns `enabled: false`) when the vault is disabled, so the default boot path
 * is unchanged.
 *
 * BOUNDED: the keychain read is a synchronous blocking Windows FFI call dispatched
 * over Electron IPC, which has no built-in timeout — a contended/wedged credential
 * Manager (or an AV shim intercepting the cred APIs) could otherwise make unlock
 * neither resolve nor reject, hanging the boot chain that awaits this. We race the
 * unlock against `timeoutMs` so the caller always settles and the data bootstraps
 * always run; a timeout reports `unlocked: false` (the vault stays locked, which
 * is safe — no rows are encrypted today).
 */
export async function unlockSecureVaultOnLaunch(
  vault: SecureVault = secureVault,
  timeoutMs: number = UNLOCK_LAUNCH_TIMEOUT_MS,
): Promise<{ enabled: boolean; unlocked: boolean; error?: string }> {
  if (!vault.isEnabled()) return { enabled: false, unlocked: false };
  const timeout = new Promise<SecureVaultResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'keychain unlock timed out' }), timeoutMs);
  });
  const result = await Promise.race([vault.unlock(), timeout]);
  return { enabled: true, unlocked: result.ok === true, error: result.error };
}
