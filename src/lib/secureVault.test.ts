import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryKeyStore,
  decryptWithDek,
  encryptWithDek,
  generateDekBase64,
  getSecureVaultStatus,
  isWindowsPlatform,
  SecureVault,
  unlockSecureVaultOnLaunch,
  type SecureKeyStore,
  type SecureVaultFlagStore,
} from './secureVault';

function memFlag(initial = false): SecureVaultFlagStore {
  let enabled = initial;
  return {
    get: () => enabled,
    set: (v) => {
      enabled = v;
    },
  };
}

/** A key store whose OS keychain is "unavailable" (browser/headless). */
const unavailableStore: SecureKeyStore = {
  async isAvailable() {
    return false;
  },
  async get() {
    return null;
  },
  async set() {
    /* no-op */
  },
  async clear() {
    /* no-op */
  },
};

describe('secureVault crypto', () => {
  it('round-trips a value through the DEK', async () => {
    const dek = generateDekBase64();
    const cipher = await encryptWithDek('the mitochondria is the powerhouse', dek);
    expect(cipher.v).toBe(1);
    expect(cipher.iv).toBeTruthy();
    expect(cipher.ct).toBeTruthy();
    expect(await decryptWithDek(cipher, dek)).toBe('the mitochondria is the powerhouse');
  });

  it('produces a distinct ciphertext each call (fresh IV)', async () => {
    const dek = generateDekBase64();
    const a = await encryptWithDek('same', dek);
    const b = await encryptWithDek('same', dek);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
  });

  it('fails to decrypt with the wrong DEK', async () => {
    const cipher = await encryptWithDek('secret', generateDekBase64());
    await expect(decryptWithDek(cipher, generateDekBase64())).rejects.toThrow(/could not decrypt/);
  });

  it('generates distinct 256-bit keys', () => {
    const a = generateDekBase64();
    const b = generateDekBase64();
    expect(a).not.toBe(b);
    // 32 bytes → 44 base64 chars (with padding).
    expect(a).toHaveLength(44);
  });
});

describe('SecureVault lifecycle', () => {
  it('enable generates + stores a key and leaves the vault unlocked', async () => {
    const store = createMemoryKeyStore();
    const vault = new SecureVault(store, memFlag());

    const result = await vault.enable();
    expect(result.ok).toBe(true);
    expect(vault.isEnabled()).toBe(true);
    expect(vault.isUnlocked()).toBe(true);
    expect(await store.get()).toBeTruthy(); // DEK persisted to the store
  });

  it('encrypt/decrypt round-trips through an unlocked vault', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag());
    await vault.enable();
    const cipher = await vault.encrypt('mastery: 0.82');
    expect(await vault.decrypt(cipher)).toBe('mastery: 0.82');
  });

  it('refuses to enable when the OS keychain is unavailable', async () => {
    const vault = new SecureVault(unavailableStore, memFlag());
    const result = await vault.enable();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/desktop app/i);
    expect(vault.isEnabled()).toBe(false);
  });

  it('unlocks from the keychain on a fresh controller (simulated relaunch)', async () => {
    const store = createMemoryKeyStore();
    const flag = memFlag();
    // First run: enable (persists the DEK + flag).
    await new SecureVault(store, flag).enable();

    // Relaunch: a NEW controller over the SAME store/flag starts locked.
    const relaunched = new SecureVault(store, flag);
    expect(relaunched.isEnabled()).toBe(true);
    expect(relaunched.isUnlocked()).toBe(false);

    const result = await relaunched.unlock();
    expect(result.ok).toBe(true);
    expect(relaunched.isUnlocked()).toBe(true);
  });

  it('lock drops the key and blocks encrypt until unlocked again', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag());
    await vault.enable();
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    await expect(vault.encrypt('x')).rejects.toThrow(/locked/);
  });

  it('unlock fails when the vault is not enabled', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag());
    const result = await vault.unlock();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
  });

  it('unlock fails when the key is missing from the keychain', async () => {
    const store = createMemoryKeyStore();
    const flag = memFlag(true); // enabled, but...
    await store.clear(); // ...no key in the store
    const vault = new SecureVault(store, flag);
    const result = await vault.unlock();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no key/i);
  });

  it('unlock rejects a corrupt / invalid stored key (validated before commit)', async () => {
    const corruptStore: SecureKeyStore = {
      async isAvailable() {
        return true;
      },
      async get() {
        return 'not-a-valid-aes-key!!'; // invalid base64 → importKey throws
      },
      async set() {
        /* no-op */
      },
      async clear() {
        /* no-op */
      },
    };
    const vault = new SecureVault(corruptStore, memFlag(true));
    const result = await vault.unlock();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a valid encryption key/i);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('disable clears the key, the flag, and locks', async () => {
    const store = createMemoryKeyStore();
    const vault = new SecureVault(store, memFlag());
    await vault.enable();

    const result = await vault.disable();
    expect(result.ok).toBe(true);
    expect(vault.isEnabled()).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
    expect(await store.get()).toBeNull();
  });
});

describe('unlockSecureVaultOnLaunch / getSecureVaultStatus', () => {
  it('is a no-op when the vault is disabled', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag(false));
    const result = await unlockSecureVaultOnLaunch(vault);
    expect(result).toEqual({ enabled: false, unlocked: false });
  });

  it('unlocks an enabled vault on launch', async () => {
    const store = createMemoryKeyStore();
    const flag = memFlag();
    await new SecureVault(store, flag).enable();

    const relaunched = new SecureVault(store, flag);
    const result = await unlockSecureVaultOnLaunch(relaunched);
    expect(result.enabled).toBe(true);
    expect(result.unlocked).toBe(true);
    expect(relaunched.isUnlocked()).toBe(true);
  });

  it('reports status accurately', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag());
    expect(await getSecureVaultStatus(vault)).toEqual({ enabled: false, unlocked: false, available: true });
    await vault.enable();
    expect(await getSecureVaultStatus(vault)).toEqual({ enabled: true, unlocked: true, available: true });
  });
});

describe('SecureVault hardening (audit follow-ups)', () => {
  /** A valid-base64 key of an arbitrary byte length (to probe length enforcement). */
  function keyOfBytes(n: number): string {
    return btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));
  }

  it('unlock rejects a valid-base64 but wrong-length (AES-128) key — pins 256-bit', async () => {
    const shortKey = keyOfBytes(16); // valid base64, importable as AES-128 without the guard
    const store: SecureKeyStore = {
      async isAvailable() {
        return true;
      },
      async get() {
        return shortKey;
      },
      async set() {
        /* no-op */
      },
      async clear() {
        /* no-op */
      },
    };
    const result = await new SecureVault(store, memFlag(true)).unlock();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a valid encryption key/i);
  });

  it('enable returns ok:false and stays disabled+locked when the keychain write fails', async () => {
    const failSet: SecureKeyStore = {
      async isAvailable() {
        return true;
      },
      async get() {
        return null;
      },
      async set() {
        throw new Error('keychain write denied');
      },
      async clear() {
        /* no-op */
      },
    };
    const vault = new SecureVault(failSet, memFlag());
    const result = await vault.enable();
    expect(result.ok).toBe(false);
    // No half-enabled state: the flag is NOT set and no DEK is held.
    expect(vault.isEnabled()).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('disable returns ok:false when the keychain clear fails', async () => {
    let stored: string | null = null;
    const failClear: SecureKeyStore = {
      async isAvailable() {
        return true;
      },
      async get() {
        return stored;
      },
      async set(v) {
        stored = v;
      },
      async clear() {
        throw new Error('keychain delete denied');
      },
    };
    const vault = new SecureVault(failClear, memFlag());
    await vault.enable();
    const result = await vault.disable();
    expect(result.ok).toBe(false);
  });

  it('decrypt throws when the vault is locked', async () => {
    const vault = new SecureVault(createMemoryKeyStore(), memFlag());
    await vault.enable();
    vault.lock();
    await expect(vault.decrypt({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' })).rejects.toThrow(/locked/);
  });

  it('unlockSecureVaultOnLaunch times out a wedged keychain read instead of hanging', async () => {
    const hangStore: SecureKeyStore = {
      async isAvailable() {
        return true;
      },
      get() {
        return new Promise<string | null>(() => {
          /* never settles — models a contended/wedged Credential Manager */
        });
      },
      async set() {
        /* no-op */
      },
      async clear() {
        /* no-op */
      },
    };
    const vault = new SecureVault(hangStore, memFlag(true));
    const result = await unlockSecureVaultOnLaunch(vault, 20);
    expect(result.enabled).toBe(true);
    expect(result.unlocked).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});

describe('isWindowsPlatform', () => {
  const orig = Object.getOwnPropertyDescriptor(navigator, 'userAgentData');
  afterEach(() => {
    if (orig) Object.defineProperty(navigator, 'userAgentData', orig);
    else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'userAgentData');
  });

  it('detects Windows via userAgentData.platform', () => {
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'Windows' }, configurable: true });
    expect(isWindowsPlatform()).toBe(true);
  });

  it('returns false for a non-Windows platform', () => {
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' }, configurable: true });
    expect(isWindowsPlatform()).toBe(false);
  });
});
