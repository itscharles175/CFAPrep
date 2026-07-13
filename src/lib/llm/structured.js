// AI-1 — structured-output engine for the host LLM.
//
// Local OpenAI-compatible servers vary wildly in how well they honour a
// requested output shape: LM Studio / llama.cpp support `response_format` with a
// JSON schema; Ollama supports `format: "json"` or a JSON-schema `format`; older
// builds support neither and only obey a strong system instruction. A small
// model (Gemma 4 E4B) also routinely wraps JSON in prose or ``` fences.
//
// `generateStructured` gives every JSON-producing host generator ONE robust
// path: it (a) requests schema-constrained output where supported, then
// VALIDATE -> REPAIR -> EXTRACT against a zod schema:
//
//   1. VALIDATE  the raw completion's parsed JSON against the schema.
//   2. REPAIR    on failure: strip a leading reasoning trace (stripThink),
//                strip markdown/code fences, and extract the first balanced JSON
//                value (object OR array) from the surrounding prose.
//   3. re-VALIDATE the repaired candidate.
//   4. on still-invalid, throw a TYPED StructuredOutputError carrying the raw
//      text + zod issues so the caller can quarantine rather than emit garbage.
//
// This module is transport-agnostic: the caller passes a `request` function that
// performs the actual fetch and returns the raw assistant text. That keeps all
// the existing CORS / timeout / dedup machinery in localLlm.js untouched and
// makes this unit testable with no network.

import { z } from 'zod';
import { stripThink } from '../stripThink';

/**
 * Typed failure from the structured engine. Thrown when the model output cannot
 * be coerced into the schema even after repair. Carries the raw text and the
 * zod issues so the caller (and contentGate) can quarantine + log precisely.
 */
export class StructuredOutputError extends Error {
  /**
   * @param {string} message
   * @param {object} [meta]
   * @param {string} [meta.raw]       - the raw model text we failed to parse
   * @param {Array}  [meta.issues]    - zod issues (or a synthetic shape)
   * @param {string} [meta.stage]     - 'parse' | 'validate' | 'empty'
   */
  constructor(message, { raw = '', issues = [], stage = 'validate' } = {}) {
    super(message);
    this.name = 'StructuredOutputError';
    this.raw = raw;
    this.issues = issues;
    this.stage = stage;
    // Mark so callers can branch without instanceof across module realms.
    this.isStructuredOutputError = true;
  }
}

/**
 * Build the OpenAI/LM-Studio `response_format` payload for a JSON schema. The
 * caller supplies a PLAIN JSON Schema (not the zod schema) because that is what
 * the wire protocol wants; zod stays the validator. When no jsonSchema is given
 * we fall back to `{ type: 'json_object' }` (widely supported "just JSON" mode),
 * and callers that can't even do that omit response_format entirely and lean on
 * the system instruction + repair stage.
 *
 * @param {object} [jsonSchema]   - a JSON Schema object describing the result
 * @param {string} [name]         - schema name for response_format
 * @returns {object|undefined} response_format payload, or undefined to omit
 */
export function buildResponseFormat(jsonSchema, name = 'structured_output') {
  if (jsonSchema && typeof jsonSchema === 'object') {
    return {
      type: 'json_schema',
      json_schema: { name, strict: true, schema: jsonSchema },
    };
  }
  return { type: 'json_object' };
}

/**
 * A short, model-agnostic system suffix that nudges weak models toward emitting
 * ONLY JSON. Appended to a generator's own system prompt by the caller (or by
 * generateStructured when it owns the messages). Kept terse + deterministic.
 */
export const JSON_ONLY_INSTRUCTION =
  'Output ONLY a single valid JSON value matching the requested shape. ' +
  'No prose, no explanation, no markdown code fences.';

/**
 * Strip markdown/code fences and extract the first balanced JSON value (object
 * or array) from arbitrary model text. Used by the repair stage; exported for
 * testing and for callers that want the raw extracted JSON string.
 *
 * Strategy:
 *   - prefer a fenced ```json … ``` (or bare ``` … ```) block if present;
 *   - otherwise scan from the first `{` or `[` and walk a brace/bracket depth
 *     counter (string- and escape-aware) to find the MATCHING close, so a JSON
 *     object followed by trailing prose is recovered cleanly.
 *
 * @param {string} text
 * @returns {string|null} the extracted JSON text, or null if none found
 */
export function extractJsonText(text) {
  if (typeof text !== 'string' || !text) return null;

  // 1. Prefer the contents of the first code fence.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fence ? fence[1] : text;

  // 2. Find the first opening bracket of a JSON value.
  let start = -1;
  let opener = '';
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (ch === '{' || ch === '[') {
      start = i;
      opener = ch;
      break;
    }
  }
  if (start === -1) return null;

  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth += 1;
    } else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  // Unbalanced — return from the opener to end as a best effort for JSON.parse
  // (it'll throw and the caller surfaces a typed error).
  return haystack.slice(start);
}

/**
 * Parse + validate raw model text against a zod schema, repairing on failure.
 * Pure (no I/O): given the raw assistant text, returns the validated value or
 * throws StructuredOutputError. Exposed for direct testing and reuse.
 *
 * @template T
 * @param {string} raw                 - raw assistant text
 * @param {import('zod').ZodType<T>} schema
 * @returns {T}
 */
export function parseStructured(raw, schema) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    throw new StructuredOutputError('Model returned empty output.', { raw: text, stage: 'empty' });
  }

  // Attempt 1: the whole (think-stripped) text is already clean JSON.
  const cleaned = stripThink(text);
  const direct = tryParseJson(cleaned);
  if (direct.ok) {
    const validated = schema.safeParse(direct.value);
    if (validated.success) return validated.data;
    // Hold the validation issues in case repair also fails.
    var lastIssues = validated.error.issues; // eslint-disable-line no-var
  }

  // Attempt 2 (REPAIR): extract the first balanced JSON value from the prose.
  const extracted = extractJsonText(cleaned);
  if (extracted) {
    const repaired = tryParseJson(extracted);
    if (repaired.ok) {
      const validated = schema.safeParse(repaired.value);
      if (validated.success) return validated.data;
      lastIssues = validated.error.issues;
    }
  }

  // Still invalid: surface a typed failure so the caller can quarantine.
  if (lastIssues) {
    throw new StructuredOutputError('Model output did not match the required schema.', {
      raw: text,
      issues: lastIssues,
      stage: 'validate',
    });
  }
  throw new StructuredOutputError('Model output was not parseable JSON.', {
    raw: text,
    stage: 'parse',
  });
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * AI-1 entry point. Requests schema-constrained JSON output via the supplied
 * transport, then VALIDATE -> REPAIR -> EXTRACT against `schema`.
 *
 * The caller owns transport: `request({ responseFormat, systemSuffix })` must
 * issue the actual chat completion (with whatever determinism/dedup/timeout the
 * host already applies) and resolve to the RAW assistant text. We pass it the
 * `responseFormat` payload to splice into the request body and a `systemSuffix`
 * to append to the system prompt; a transport free to ignore either (e.g. a
 * server that rejects response_format) still works because repair recovers JSON
 * from prose.
 *
 * @template T
 * @param {object} params
 * @param {import('zod').ZodType<T>} params.schema   - zod validator for the result
 * @param {object} [params.jsonSchema]               - JSON Schema for response_format
 * @param {string} [params.schemaName]               - response_format schema name
 * @param {(args: { responseFormat: object|undefined, systemSuffix: string }) => Promise<string>} params.request
 * @returns {Promise<T>} the validated value
 * @throws {StructuredOutputError} when output can't be coerced to the schema
 */
export async function generateStructured({ schema, jsonSchema, schemaName, request }) {
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new TypeError('generateStructured requires a zod `schema`.');
  }
  if (typeof request !== 'function') {
    throw new TypeError('generateStructured requires a `request` transport function.');
  }
  const responseFormat = buildResponseFormat(jsonSchema, schemaName);
  const raw = await request({ responseFormat, systemSuffix: JSON_ONLY_INSTRUCTION });
  return parseStructured(raw, schema);
}

// Re-export z for callers that build schemas alongside this engine.
export { z };
