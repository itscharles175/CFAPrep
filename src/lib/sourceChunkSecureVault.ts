import type { CfaSourceChunk } from './cfaSourceTypes';
import { secureVault, type SecureCipher, type SecureVault } from './secureVault';

export const SECURE_SOURCE_CHUNK_SCHEME = 'secure-vault-source-chunk.v1';
export const ENCRYPTED_SOURCE_CHUNK_TEXT = 'This source chunk is encrypted at rest. Unlock Secure Vault to read it.';
export const ENCRYPTED_SOURCE_CHUNK_HEADING = '[Secure Vault encrypted source chunk]';

type SecureSourceChunkPayload = NonNullable<CfaSourceChunk['secureVault']>;

type SourceChunkLike = {
  text: string;
  normalizedText?: string;
  heading?: string;
  learningOutcomes?: string[];
  secureVault?: SecureSourceChunkPayload;
};

let sourceChunkSecureVault: SecureVault = secureVault;

export function setSourceChunkSecureVaultForTesting(vault: SecureVault | null) {
  sourceChunkSecureVault = vault ?? secureVault;
}

function isCipher(value: unknown): value is SecureCipher {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { iv?: unknown }).iv === 'string' &&
    typeof (value as { ct?: unknown }).ct === 'string'
  );
}

export function isSecureSourceChunk<T extends { secureVault?: unknown }>(
  chunk: T | undefined,
): chunk is T & { secureVault: SecureSourceChunkPayload } {
  const payload = chunk?.secureVault as Partial<SecureSourceChunkPayload> | undefined;
  return (
    payload?.v === 1 &&
    payload.scheme === SECURE_SOURCE_CHUNK_SCHEME &&
    isCipher(payload.text) &&
    (payload.normalizedText === undefined || isCipher(payload.normalizedText)) &&
    (payload.heading === undefined || isCipher(payload.heading)) &&
    (payload.learningOutcomes === undefined || isCipher(payload.learningOutcomes))
  );
}

function assertSourceChunkVaultUnlocked(vault: SecureVault) {
  if (!vault.isUnlocked()) {
    throw new Error('Secure Vault is enabled but locked. Unlock it before reading or writing source chunks.');
  }
}

function parseLearningOutcomes(value: string): string[] | undefined {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('Secure Vault source chunk learningOutcomes payload is invalid.');
  }
  return parsed;
}

export async function encryptSourceChunkForStorage<T extends SourceChunkLike>(
  chunk: T,
  vault: SecureVault = sourceChunkSecureVault,
): Promise<T> {
  if (!vault.isEnabled()) {
    const { secureVault: _secureVault, ...plain } = chunk;
    return plain as T;
  }
  if (isSecureSourceChunk(chunk)) return chunk;
  assertSourceChunkVaultUnlocked(vault);

  return {
    ...chunk,
    text: ENCRYPTED_SOURCE_CHUNK_TEXT,
    normalizedText: '',
    ...(chunk.heading ? { heading: ENCRYPTED_SOURCE_CHUNK_HEADING } : {}),
    ...(Array.isArray(chunk.learningOutcomes) ? { learningOutcomes: [] } : {}),
    secureVault: {
      v: 1,
      scheme: SECURE_SOURCE_CHUNK_SCHEME,
      text: await vault.encrypt(chunk.text),
      ...(typeof chunk.normalizedText === 'string' ? { normalizedText: await vault.encrypt(chunk.normalizedText) } : {}),
      ...(chunk.heading ? { heading: await vault.encrypt(chunk.heading) } : {}),
      ...(Array.isArray(chunk.learningOutcomes)
        ? { learningOutcomes: await vault.encrypt(JSON.stringify(chunk.learningOutcomes)) }
        : {}),
    },
  };
}

export async function encryptSourceChunksForStorage<T extends SourceChunkLike>(
  chunks: T[],
  vault: SecureVault = sourceChunkSecureVault,
): Promise<T[]> {
  return Promise.all(chunks.map((chunk) => encryptSourceChunkForStorage(chunk, vault)));
}

export async function decryptSourceChunkForRead<T extends SourceChunkLike>(
  chunk: T | undefined,
  vault: SecureVault = sourceChunkSecureVault,
): Promise<T | undefined> {
  if (!chunk || !isSecureSourceChunk(chunk)) return chunk;
  assertSourceChunkVaultUnlocked(vault);
  const { secureVault: _secureVault, ...plain } = chunk;
  return {
    ...plain,
    text: await vault.decrypt(chunk.secureVault.text),
    ...(chunk.secureVault.normalizedText
      ? { normalizedText: await vault.decrypt(chunk.secureVault.normalizedText) }
      : {}),
    ...(chunk.secureVault.heading ? { heading: await vault.decrypt(chunk.secureVault.heading) } : {}),
    ...(chunk.secureVault.learningOutcomes
      ? { learningOutcomes: parseLearningOutcomes(await vault.decrypt(chunk.secureVault.learningOutcomes)) }
      : {}),
  } as T;
}

export async function decryptSourceChunksForRead<T extends SourceChunkLike>(
  chunks: T[],
  vault: SecureVault = sourceChunkSecureVault,
): Promise<T[]> {
  const decrypted: T[] = [];
  for (const chunk of chunks) {
    const plain = await decryptSourceChunkForRead(chunk, vault);
    if (plain) decrypted.push(plain);
  }
  return decrypted;
}
