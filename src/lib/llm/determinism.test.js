import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CACHE_KEY_VERSION,
  DEFAULT_SEED,
  STRUCTURED_SAMPLING,
  cacheKey,
  cacheKeyPreimage,
  sha256Hex,
  withDeterminism,
} from './determinism';

describe('withDeterminism — pinned sampling contract', () => {
  it('threads the fixed seed + pinned temperature/top_p into a request body', () => {
    const out = withDeterminism({ model: 'gemma', messages: [{ role: 'user', content: 'x' }] });
    expect(out.seed).toBe(DEFAULT_SEED);
    expect(out.temperature).toBe(STRUCTURED_SAMPLING.temperature);
    expect(out.top_p).toBe(STRUCTURED_SAMPLING.top_p);
    // Preserves the rest of the body.
    expect(out.model).toBe('gemma');
    expect(out.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('every structured call sends a numeric seed (determinism guarantee)', () => {
    const out = withDeterminism({ model: 'm' });
    expect(Number.isInteger(out.seed)).toBe(true);
  });

  it('overrides a caller-supplied temperature/seed already on the body', () => {
    const out = withDeterminism({ model: 'm', temperature: 0.9, seed: 7 });
    expect(out.temperature).toBe(STRUCTURED_SAMPLING.temperature);
    expect(out.seed).toBe(DEFAULT_SEED);
  });

  it('honors explicit opts overrides (e.g. a repair retry with a different seed)', () => {
    const out = withDeterminism({ model: 'm' }, { seed: 42, temperature: 0.2, top_p: 0.5 });
    expect(out.seed).toBe(42);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.5);
  });

  it('does not mutate the input body', () => {
    const body = { model: 'm' };
    withDeterminism(body);
    expect(body).toEqual({ model: 'm' });
  });
});

describe('cacheKey — content-addressed, reproducible', () => {
  const base = {
    provider: 'lmstudio',
    model: 'gemma-4-e4b-it',
    system: 'Generate LSAT-quality JSON only.',
    format: { type: 'object', properties: { questions: { type: 'array' } } },
    temperature: 0,
    top_p: STRUCTURED_SAMPLING.top_p,
    seed: DEFAULT_SEED,
    prompt: 'Write 3 questions about duration.',
  };

  it('is a 64-char lowercase hex SHA-256', async () => {
    const key = await cacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input -> same key (conformance)', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base });
    expect(a).toBe(b);
  });

  it('different prompt -> different key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base, prompt: `${base.prompt} extra` });
    expect(a).not.toBe(b);
  });

  it('different seed -> different key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base, seed: base.seed + 1 });
    expect(a).not.toBe(b);
  });

  it('different model/provider/temperature -> different key', async () => {
    const a = await cacheKey(base);
    expect(await cacheKey({ ...base, model: 'other' })).not.toBe(a);
    expect(await cacheKey({ ...base, provider: 'ollama' })).not.toBe(a);
    expect(await cacheKey({ ...base, temperature: 0.3 })).not.toBe(a);
  });

  it('different system/format/top_p -> different key', async () => {
    const a = await cacheKey(base);
    expect(await cacheKey({ ...base, system: 'Different system.' })).not.toBe(a);
    expect(await cacheKey({ ...base, format: 'json' })).not.toBe(a);
    expect(await cacheKey({ ...base, top_p: 0.9 })).not.toBe(a);
  });

  it('canonicalizes schema object key order', async () => {
    const schemaA = {
      type: 'object',
      properties: { b: { type: 'number' }, a: { type: 'string' } },
    };
    const schemaB = {
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      type: 'object',
    };
    expect(await cacheKey({ ...base, format: schemaA })).toBe(
      await cacheKey({ ...base, format: schemaB }),
    );
  });

  it('temperature 0 and missing temperature are DISTINCT keys', async () => {
    const withTemp = await cacheKey({ ...base, temperature: 0 });
    const noTemp = await cacheKey({ ...base, temperature: undefined });
    expect(withTemp).not.toBe(noTemp);
  });

  it('exposes the EXACT frozen pre-image format the backend (BACK-1) must match', () => {
    expect(CACHE_KEY_VERSION).toBe(2);
    const pre = cacheKeyPreimage(base);
    expect(pre).toBe(
      [
        'llm-cache',
        'v2',
        'provider=lmstudio',
        'model=gemma-4-e4b-it',
        'system="Generate LSAT-quality JSON only."',
        'format={"properties":{"questions":{"type":"array"}},"type":"object"}',
        'temperature=0',
        'top_p=1',
        `seed=${DEFAULT_SEED}`,
        'prompt=Write 3 questions about duration.',
      ].join('\n'),
    );
  });

  it('matches the frozen backend digest vector', async () => {
    expect(await cacheKey(base)).toBe(
      '6d11a145d16b2d0d23c88370a78dea1a9b8a3c03dc54ca0a16c7e7c1613870d9',
    );
  });

  it('prompt is the LAST field, so newlines/= inside it cannot spoof another field', async () => {
    const sneaky = await cacheKey({ ...base, prompt: 'a\nseed=999\nmodel=evil' });
    const honest = await cacheKey({ ...base, prompt: 'a different prompt' });
    expect(sneaky).not.toBe(honest);
    // And it stays a valid digest.
    expect(sneaky).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cacheKey is sha256Hex of cacheKeyPreimage (self-consistent)', async () => {
    expect(await cacheKey(base)).toBe(await sha256Hex(cacheKeyPreimage(base)));
  });
});

describe('sha256Hex — matches the FIPS-180-4 reference vector', () => {
  it('hashes the empty string to the canonical digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc" to the canonical digest', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('property: stable + 64-char hex for arbitrary strings (offline)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (s) => {
        const a = await sha256Hex(s);
        const b = await sha256Hex(s);
        return a === b && /^[0-9a-f]{64}$/.test(a);
      }),
      { numRuns: 50 },
    );
  });
});
