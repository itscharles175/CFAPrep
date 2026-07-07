// Ambient types for the plain-JS determinism module (src/lib/llm/determinism.js)
// so .ts consumers (e.g. src/lib/storage/integrity.ts) type-check under the
// stricter LSAT tsconfig (which does not allowJs). Keep in sync with determinism.js.

/** Fixed seed used for reproducible structured generation. */
export const DEFAULT_SEED: number;

/** Pinned sampling for deterministic (non-creative) calls. */
export const STRUCTURED_SAMPLING: { readonly temperature: number; readonly top_p: number };

/** Version tag baked into the content-addressed cache-key pre-image. */
export const CACHE_KEY_VERSION: number;

export interface DeterminismOpts {
  seed?: number;
  temperature?: number;
  top_p?: number;
}

/** Thread a fixed seed + pinned sampling into a chat-completion request body. */
export function withDeterminism<T extends Record<string, unknown>>(
  body: T,
  opts?: DeterminismOpts,
): T & { seed: number; temperature: number; top_p: number };

export interface CacheKeyArgs {
  provider?: string;
  model?: string;
  system?: string;
  format?: unknown;
  temperature?: number;
  top_p?: number;
  seed?: number;
  prompt?: string;
}

/** Content-addressed cache key (SHA-256 hex over the frozen pre-image). */
export function cacheKey(args?: CacheKeyArgs): Promise<string>;

/** The exact, byte-stable pre-image hashed by {@link cacheKey} (for backend parity). */
export function cacheKeyPreimage(args?: CacheKeyArgs): string;

/** SHA-256 hex of a string (Web Crypto with a pure-JS fallback; offline). */
export function sha256Hex(text: string): Promise<string>;
