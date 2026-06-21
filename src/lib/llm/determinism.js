// GAP-DETERMINISM-1 — host LLM determinism contract.
//
// The host's structured (non-creative) generations — practice questions,
// flashcards, rubric grades, topic summaries — must be REPRODUCIBLE so every
// downstream eval/learning improvement is provable. Historically localLlm.js
// set only `temperature` and never a `seed` or a pinned `top_p`, so two
// identical requests could diverge and no two machines could agree on output.
//
// This module is the single source of truth for two things:
//
//   1. PINNED SAMPLING — `withDeterminism(body, opts)` threads a fixed seed plus
//      pinned temperature/top_p into an OpenAI-compatible chat-completions body.
//      OpenAI-compatible local servers (Ollama, LM Studio/llama.cpp) accept a
//      top-level `seed` and honour `temperature`/`top_p`; we set all three so a
//      structured call is as close to greedy-deterministic as the backend allows.
//
//   2. CONTENT-ADDRESSED CACHE KEY — `cacheKey({provider, model, temperature,
//      seed, prompt})` returns a sha256 hex digest. The host caches generated
//      content by this key; the backend (BACK-1, later) must reproduce the SAME
//      key for the SAME inputs, so the exact serialization is frozen and
//      documented below. DO NOT change it without bumping CACHE_KEY_VERSION and
//      updating the backend.
//
// Everything here is pure + offline. sha256 uses Web Crypto `subtle.digest`
// when available (browser + Tauri webview + jsdom/Node webcrypto) and falls
// back to a tiny self-contained synchronous SHA-256 otherwise, so the helpers
// work in every host environment and in vitest with no network and no deps.

// --- pinned sampling defaults -------------------------------------------------

// Fixed seed for ALL structured calls. A single constant (not per-call random)
// is the whole point: same inputs -> same seed -> same completion. Chosen once,
// arbitrary, stable forever. (The backend must use the same default.)
export const DEFAULT_SEED = 1311;

// Pinned sampling for structured/JSON generation. Near-greedy: low temperature
// trims variance, top_p kept tight. Creative paths (explain/coach/narrate) do
// NOT use this — they keep their own warmer temperatures.
export const STRUCTURED_SAMPLING = Object.freeze({
  temperature: 0,
  top_p: 1,
});

/**
 * Thread a fixed seed + pinned sampling into an OpenAI-compatible request body
 * so a structured generation is reproducible. Returns a NEW object (does not
 * mutate the input). Caller-provided `temperature`/`top_p`/`seed` already on the
 * body are overridden by the determinism contract unless explicitly passed in
 * `opts` (which lets a caller pin a DIFFERENT seed, e.g. for a repair retry).
 *
 * @param {object} body                 - chat-completions body (model, messages, …)
 * @param {object} [opts]
 * @param {number} [opts.seed]          - override the fixed seed
 * @param {number} [opts.temperature]   - override pinned temperature
 * @param {number} [opts.top_p]         - override pinned top_p
 * @returns {object} a new body with `seed`, `temperature`, `top_p` pinned
 */
export function withDeterminism(body, opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_SEED;
  const temperature = Number.isFinite(opts.temperature)
    ? opts.temperature
    : STRUCTURED_SAMPLING.temperature;
  const top_p = Number.isFinite(opts.top_p) ? opts.top_p : STRUCTURED_SAMPLING.top_p;
  return {
    ...(body || {}),
    seed,
    temperature,
    top_p,
  };
}

// --- content-addressed cache key ---------------------------------------------

// Bump this if the key serialization below ever changes; the backend (BACK-1)
// keys off the same version so a host/backend mismatch is detectable rather
// than silently producing two different keys for the same logical input.
export const CACHE_KEY_VERSION = 1;

/**
 * EXACT cache-key format — frozen contract for host <-> backend reproducibility.
 *
 * Pre-image string (UTF-8), fields joined by a single newline, in THIS order:
 *
 *     llm-cache\n
 *     v<CACHE_KEY_VERSION>\n
 *     provider=<provider>\n
 *     model=<model>\n
 *     temperature=<temperatureCanonical>\n
 *     seed=<seed>\n
 *     prompt=<prompt>
 *
 * Field rules (so independent implementations agree byte-for-byte):
 *   - provider / model : trimmed string; missing -> "" (empty).
 *   - temperature      : canonical number string via canonicalNumber() — an
 *                        integer-valued temperature renders WITHOUT a trailing
 *                        ".0" (e.g. 0, not 0.0), non-integers via Number#toString.
 *                        Missing/non-finite -> "" (empty), so "no temperature"
 *                        and "temperature 0" are DISTINCT keys.
 *   - seed             : integer rendered via canonicalNumber(); missing -> "".
 *   - prompt           : the full prompt string verbatim (NOT trimmed — leading/
 *                        trailing whitespace is significant to the model and so
 *                        to the key). Non-string -> "".
 *
 * The key is the lowercase hex SHA-256 of that pre-image. There is exactly one
 * `prompt=` field and it is LAST, so a prompt containing newlines or `=` cannot
 * be confused with a later field (nothing follows it).
 */
export async function cacheKey({ provider, model, temperature, seed, prompt } = {}) {
  return sha256Hex(cacheKeyPreimage({ provider, model, temperature, seed, prompt }));
}

/**
 * The exact pre-image string SHA-256'd by {@link cacheKey}. Exposed (and used by
 * the conformance test) so the backend implementer can diff their serialization
 * against this without having to also match a hash.
 */
export function cacheKeyPreimage({ provider, model, temperature, seed, prompt } = {}) {
  const fields = [
    'llm-cache',
    `v${CACHE_KEY_VERSION}`,
    `provider=${str(provider)}`,
    `model=${str(model)}`,
    `temperature=${canonicalNumber(temperature)}`,
    `seed=${canonicalNumber(seed)}`,
    `prompt=${typeof prompt === 'string' ? prompt : ''}`,
  ];
  return fields.join('\n');
}

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// Canonical numeric rendering for the key: finite numbers via Number#toString
// (so 0 -> "0", 0.3 -> "0.3", 1311 -> "1311"); anything non-finite/missing -> "".
function canonicalNumber(v) {
  return Number.isFinite(v) ? String(v) : '';
}

// --- sha256 (Web Crypto, with a tiny offline fallback) ------------------------

/**
 * SHA-256 of a UTF-8 string -> lowercase hex. Uses `crypto.subtle.digest` when
 * present (the normal path in the browser, Tauri webview, and Node/jsdom under
 * vitest); otherwise a self-contained synchronous implementation so the helper
 * never depends on a polyfill being installed. Always async for a single,
 * stable call signature.
 *
 * @param {string} text
 * @returns {Promise<string>} 64-char lowercase hex digest
 */
export async function sha256Hex(text) {
  const bytes = utf8Bytes(typeof text === 'string' ? text : String(text ?? ''));
  const subtle = globalThis?.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const buf = await subtle.digest('SHA-256', bytes);
      return bufToHex(new Uint8Array(buf));
    } catch {
      // Fall through to the pure-JS path on any subtle failure.
    }
  }
  return bufToHex(sha256Bytes(bytes));
}

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  // Minimal UTF-8 encoder fallback (very old environments only).
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

function bufToHex(u8) {
  let hex = '';
  for (let i = 0; i < u8.length; i += 1) hex += u8[i].toString(16).padStart(2, '0');
  return hex;
}

// --- pure-JS SHA-256 (fallback only; standard FIPS-180-4) --------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(message) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = message.length;
  const bitLen = len * 8;
  // Padded length: message + 0x80 + zeros + 8-byte length, multiple of 64.
  const paddedLen = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(message);
  buf[len] = 0x80;
  // 64-bit big-endian bit length in the final 8 bytes (lengths well under 2^32
  // here, so the high word stays 0 — fine for our key pre-images).
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, h[i], false);
  return out;
}

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
