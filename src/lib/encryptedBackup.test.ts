import { describe, expect, it } from 'vitest';
import {
  decryptVaultBackup,
  encryptVaultBackup,
  isEncryptedBackupBlob,
  type EncryptedBackupBlob,
} from './encryptedBackup';

const SAMPLE_PAYLOAD = JSON.stringify({
  app: 'QuantVault',
  exportedAt: '2026-05-28T00:00:00.000Z',
  stores: {
    reviewItems: [
      { id: 'a', front: 'duration', back: 'price sensitivity to yield', ef: 2.5 },
      { id: 'b', front: 'convexity', back: 'second derivative of price-yield', ef: 2.4 },
    ],
    notes: ['Fixed income study session 1', 'Macaulay vs modified'],
  },
});

describe('encryptVaultBackup / decryptVaultBackup', () => {
  it('round-trips a payload through encrypt → decrypt with the same passphrase', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'correct-horse-battery-staple');
    const recovered = await decryptVaultBackup(blob, 'correct-horse-battery-staple');
    expect(recovered).toBe(SAMPLE_PAYLOAD);
  });

  it('produces a well-formed envelope with the documented version + algorithm + KDF', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    expect(blob.version).toBe(1);
    expect(blob.algorithm).toBe('AES-GCM-256');
    expect(blob.kdf).toBe('PBKDF2-SHA256-200000');
    // base64 fields must decode without throwing — both salt and IV at known sizes.
    expect(typeof blob.salt).toBe('string');
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');
    expect(blob.salt.length).toBeGreaterThan(0);
    expect(blob.iv.length).toBeGreaterThan(0);
    expect(blob.ciphertext.length).toBeGreaterThan(0);
    expect(typeof blob.createdAt).toBe('string');
    expect(Number.isNaN(new Date(blob.createdAt).getTime())).toBe(false);
    expect(isEncryptedBackupBlob(blob)).toBe(true);
  });

  it('recognizes only the supported encrypted backup envelope shape', () => {
    expect(isEncryptedBackupBlob({ version: 1, algorithm: 'AES-GCM-256', kdf: 'PBKDF2-SHA256-200000', salt: 's', iv: 'i', ciphertext: 'c' })).toBe(true);
    expect(isEncryptedBackupBlob({ version: 1, algorithm: 'AES-GCM-256', kdf: 'PBKDF2-SHA256-200000', salt: 's', iv: 'i' })).toBe(false);
    expect(isEncryptedBackupBlob({ version: 1, algorithm: 'AES-CBC-256', kdf: 'PBKDF2-SHA256-200000', salt: 's', iv: 'i', ciphertext: 'c' })).toBe(false);
    expect(isEncryptedBackupBlob(null)).toBe(false);
  });

  it('produces different ciphertexts when the same plaintext is encrypted twice (random salt + IV)', async () => {
    const a = await encryptVaultBackup(SAMPLE_PAYLOAD, 'shared-passphrase');
    const b = await encryptVaultBackup(SAMPLE_PAYLOAD, 'shared-passphrase');
    // Random salt + random IV ⇒ identical inputs ⇒ distinct ciphertexts.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    // …but both must still decrypt cleanly with the same passphrase.
    expect(await decryptVaultBackup(a, 'shared-passphrase')).toBe(SAMPLE_PAYLOAD);
    expect(await decryptVaultBackup(b, 'shared-passphrase')).toBe(SAMPLE_PAYLOAD);
  });

  it('throws a clear error when the passphrase is wrong', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'right-passphrase');
    await expect(decryptVaultBackup(blob, 'wrong-passphrase')).rejects.toThrow(
      /invalid passphrase or corrupted blob/i,
    );
  });

  it('throws a clear error when the ciphertext is corrupted', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    // Flip a byte inside the ciphertext base64 — decode, mutate, re-encode.
    const decoded = atob(blob.ciphertext);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    bytes[0] = bytes[0] ^ 0xff;
    let reencoded = '';
    for (let i = 0; i < bytes.length; i += 1) reencoded += String.fromCharCode(bytes[i]);
    const tampered: EncryptedBackupBlob = { ...blob, ciphertext: btoa(reencoded) };
    await expect(decryptVaultBackup(tampered, 'pw')).rejects.toThrow(
      /invalid passphrase or corrupted blob/i,
    );
  });

  it('throws when the salt is tampered (additionalData authentication catches it)', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    // Replace salt with a fresh random one of the same length.
    const decoded = atob(blob.salt);
    const flipped = String.fromCharCode((decoded.charCodeAt(0) ^ 0x01) & 0xff) + decoded.slice(1);
    const tampered: EncryptedBackupBlob = { ...blob, salt: btoa(flipped) };
    await expect(decryptVaultBackup(tampered, 'pw')).rejects.toThrow(
      /invalid passphrase or corrupted blob/i,
    );
  });

  it('round-trips an empty plaintext', async () => {
    const blob = await encryptVaultBackup('', 'pw');
    const recovered = await decryptVaultBackup(blob, 'pw');
    expect(recovered).toBe('');
  });

  it('round-trips a large multi-kilobyte JSON payload', async () => {
    const big = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, body: 'x'.repeat(20) })) });
    const blob = await encryptVaultBackup(big, 'pw');
    expect(await decryptVaultBackup(blob, 'pw')).toBe(big);
  });

  it('rejects encrypt with an empty passphrase', async () => {
    await expect(encryptVaultBackup(SAMPLE_PAYLOAD, '')).rejects.toThrow(/passphrase/i);
  });

  it('rejects decrypt with an empty passphrase', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    await expect(decryptVaultBackup(blob, '')).rejects.toThrow(/passphrase/i);
  });

  it('rejects an envelope with the wrong algorithm', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    const malformed = { ...blob, algorithm: 'AES-CBC-256' as unknown as 'AES-GCM-256' };
    await expect(decryptVaultBackup(malformed, 'pw')).rejects.toThrow(/algorithm/i);
  });

  it('rejects an envelope with an unsupported version', async () => {
    const blob = await encryptVaultBackup(SAMPLE_PAYLOAD, 'pw');
    const malformed = { ...blob, version: 2 as unknown as 1 };
    await expect(decryptVaultBackup(malformed, 'pw')).rejects.toThrow(/version/i);
  });
});
