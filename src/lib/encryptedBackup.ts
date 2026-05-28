/*
 * Encrypted vault backup — passphrase-protected AES-GCM-256 wrapper around the
 * existing plaintext export. Self-contained so it can wrap *any* JSON string,
 * not just the plaintext vault payload, and so the on-disk envelope is a small
 * stable shape that future migrations can audit.
 *
 * Design notes:
 *  - PBKDF2-SHA256 with 200_000 iterations stretches a human passphrase into a
 *    256-bit AES key. Iteration count is fixed so a stolen blob without the
 *    passphrase requires the same brute-force cost as encryption.
 *  - Random 16-byte salt per blob → identical passphrases on different blobs
 *    derive distinct keys (no rainbow tables).
 *  - Random 12-byte IV per encryption → identical plaintexts encrypted twice
 *    produce different ciphertexts (semantic security).
 *  - The salt is passed as `additionalData` so AES-GCM authenticates it; a
 *    tampered salt would change the derived key and the tag would mismatch.
 *  - On AES-GCM tag failure WebCrypto throws an opaque DOMException; we
 *    rewrap to a human "invalid passphrase or corrupted blob" message so the
 *    SystemHealth UI can show something actionable.
 */

export interface EncryptedBackupBlob {
  version: 1;
  algorithm: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256-200000';
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  createdAt: string; // ISO timestamp
}

const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

function requireCryptoSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is required for encrypted vault backups.');
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

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = requireCryptoSubtle();
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a JSON string with a passphrase using AES-GCM-256 over a
 * PBKDF2-derived key. Both salt and IV are fresh per call so two encryptions
 * of the same plaintext produce distinct ciphertexts.
 *
 * @throws Error if no passphrase is supplied or Web Crypto is missing.
 */
export async function encryptVaultBackup(
  plaintextJson: string,
  passphrase: string,
): Promise<EncryptedBackupBlob> {
  if (!passphrase) {
    throw new Error('Encrypted vault backups require a passphrase.');
  }
  const subtle = requireCryptoSubtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(iv),
        // Authenticate the salt so tampering it invalidates the GCM tag.
        additionalData: new Uint8Array(salt),
      },
      key,
      new TextEncoder().encode(plaintextJson),
    ),
  );
  return {
    version: 1,
    algorithm: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256-200000',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    createdAt: new Date().toISOString(),
  };
}

function ensureBlobShape(blob: EncryptedBackupBlob): void {
  if (!blob || typeof blob !== 'object') {
    throw new Error('Invalid encrypted backup blob: not an object.');
  }
  if (blob.version !== 1) {
    throw new Error(`Unsupported encrypted backup version: ${String((blob as { version?: unknown }).version)}`);
  }
  if (blob.algorithm !== 'AES-GCM-256') {
    throw new Error(`Unsupported encrypted backup algorithm: ${String(blob.algorithm)}`);
  }
  if (blob.kdf !== 'PBKDF2-SHA256-200000') {
    throw new Error(`Unsupported encrypted backup KDF: ${String(blob.kdf)}`);
  }
  if (typeof blob.salt !== 'string' || typeof blob.iv !== 'string' || typeof blob.ciphertext !== 'string') {
    throw new Error('Encrypted backup blob is missing required base64 fields.');
  }
}

/**
 * Decrypt an encrypted backup blob with the user-supplied passphrase.
 *
 * @throws Error("invalid passphrase or corrupted blob") if AES-GCM
 * authentication fails — either because the passphrase is wrong (the derived
 * key won't match) or because the ciphertext / IV / salt have been tampered
 * with. The two cases are deliberately indistinguishable from the outside.
 */
export async function decryptVaultBackup(
  blob: EncryptedBackupBlob,
  passphrase: string,
): Promise<string> {
  if (!passphrase) {
    throw new Error('Encrypted vault backups require a passphrase.');
  }
  ensureBlobShape(blob);
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64ToBytes(blob.salt);
    iv = base64ToBytes(blob.iv);
    ciphertext = base64ToBytes(blob.ciphertext);
  } catch {
    throw new Error('invalid passphrase or corrupted blob');
  }
  const subtle = requireCryptoSubtle();
  const key = await deriveAesKey(passphrase, salt);
  try {
    const decrypted = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(iv),
        additionalData: new Uint8Array(salt),
      },
      key,
      new Uint8Array(ciphertext),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    // WebCrypto throws an opaque DOMException on tag mismatch (wrong key or
    // tampered ciphertext). Rewrap as a clear, actionable user-facing error.
    throw new Error('invalid passphrase or corrupted blob');
  }
}
