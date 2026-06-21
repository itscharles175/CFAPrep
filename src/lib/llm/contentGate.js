// AI-2 — universal generated-content quality gate.
//
// A single gate at the GENERATION BOUNDARY so every piece of LLM-authored
// content — CFA practice questions, Today/targeted drills, flashcards — must
// clear the same bar before it can reach the learner. The gate checks three
// things and QUARANTINES (does not emit) anything that fails:
//
//   1. SHAPE / SCHEMA   — the value already passed the zod schema in the
//      structured engine, but the gate re-asserts the safety-critical invariants
//      that a schema alone can't (e.g. a question's `correct` index points at a
//      real option; options are distinct and non-empty).
//   2. ANSWER-RANGE / OPTION SANITY — for MCQs: >=2 options, a valid 0-based
//      `correct` index, no duplicate/blank options, no "all/none of the above"
//      degeneracy that breaks single-best-answer drills.
//   3. GROUNDEDNESS (lightweight, deterministic) — generated content claims to
//      be grounded "ONLY in the provided excerpts". With no entailment model on
//      the host yet, we use a cheap token-overlap heuristic: the content's
//      salient tokens must have meaningful overlap with the source context, so a
//      hallucinated question with zero anchoring to the curriculum is flagged.
//
//      ── SEAM (RAG-4 / GAP-ENTAIL-1) ───────────────────────────────────────
//      The groundedness check is intentionally a pluggable function. In Wave 5
//      a shared ENTAILMENT SERVICE replaces `tokenOverlapGroundedness` with a
//      real NLI/entailment call (host-side or sidecar). Pass `groundednessFn`
//      to `runContentGate` to swap it; the default heuristic keeps the gate
//      useful and fully offline until then. Do NOT inline the heuristic at call
//      sites — always go through this seam so the upgrade is one edit.
//
// The gate NEVER throws on bad content: it returns a structured verdict
// { ok, value?, violations, quarantined? } so callers can drop/route the item
// without a try/catch around every generation. It DOES throw only on caller
// misuse (e.g. a missing kind).

/**
 * @typedef {Object} GateViolation
 * @property {string} code     - machine code, e.g. 'OPTION_COUNT', 'UNGROUNDED'
 * @property {string} message  - human-readable reason
 * @property {'shape'|'range'|'grounding'} category
 */

/**
 * @typedef {Object} GateResult
 * @property {boolean} ok
 * @property {*} [value]              - the accepted value (when ok)
 * @property {GateViolation[]} violations
 * @property {boolean} [quarantined]  - true when the item was rejected
 */

// Minimum normalized token overlap (0..1) between generated content and the
// grounding context for the content to count as "grounded". Deliberately low:
// the heuristic is a hallucination tripwire, not a precision instrument. A real
// entailment model (RAG-4 seam) raises the bar properly.
export const DEFAULT_GROUNDEDNESS_THRESHOLD = 0.12;

// Common English stopwords + CFA boilerplate that carry no grounding signal.
const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at for with without by from as is are was were be been being ' +
    'this that these those it its which who whom whose what when where why how all any each every both few more ' +
    'most other some such no nor not only own same so than too very can will just should now about into over under ' +
    'question following best correct answer option options explanation true false none above'
  ).split(/\s+/),
);

/** Normalize text into a set of salient lowercase tokens (>=3 chars, no stopwords). */
function salientTokens(text) {
  const out = new Set();
  if (typeof text !== 'string') return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Default groundedness heuristic: fraction of the content's salient tokens that
 * also appear in the grounding context. Returns a score in [0,1]. When there is
 * NO context to check against, returns 1 (grounding is not asserted, so don't
 * penalize) — callers that require grounding must pass a non-empty `context`.
 *
 * @param {string} content   - the generated text (question + options + …)
 * @param {string} context   - the grounding source text (curriculum excerpts)
 * @returns {number} overlap score in [0,1]
 */
export function tokenOverlapGroundedness(content, context) {
  const ctx = salientTokens(context);
  if (ctx.size === 0) return 1; // nothing to ground against -> don't flag
  const tokens = salientTokens(content);
  // No salient tokens in the content (e.g. only stopwords/very short tokens):
  // groundedness is not assessable, so don't penalize — any genuine shape
  // problem (empty stem, blank options) is caught by the sanity checks instead.
  if (tokens.size === 0) return 1;
  let hit = 0;
  for (const t of tokens) if (ctx.has(t)) hit += 1;
  return hit / tokens.size;
}

/**
 * Validate a single multiple-choice question's range/option sanity. Returns the
 * list of violations (empty = clean). Schema/shape is assumed already enforced
 * upstream; this layers the answer-key invariants a schema can't express.
 *
 * @param {{ question?: string, options?: any[], correct?: number }} q
 * @returns {GateViolation[]}
 */
export function checkMcqSanity(q) {
  const violations = [];
  const options = Array.isArray(q?.options) ? q.options : [];
  if (typeof q?.question !== 'string' || !q.question.trim()) {
    violations.push({ code: 'EMPTY_STEM', message: 'Question stem is empty.', category: 'shape' });
  }
  if (options.length < 2) {
    violations.push({ code: 'OPTION_COUNT', message: 'Fewer than 2 answer options.', category: 'range' });
  }
  const normalized = options.map((o) => String(o ?? '').trim());
  if (normalized.some((o) => !o)) {
    violations.push({ code: 'BLANK_OPTION', message: 'At least one option is blank.', category: 'range' });
  }
  const distinct = new Set(normalized.map((o) => o.toLowerCase()));
  if (distinct.size !== normalized.length) {
    violations.push({ code: 'DUP_OPTION', message: 'Duplicate answer options.', category: 'range' });
  }
  // "all/none of the above" breaks single-best-answer drilling.
  if (normalized.some((o) => /\b(all|none)\s+of\s+the\s+above\b/i.test(o))) {
    violations.push({
      code: 'META_OPTION',
      message: '"All/None of the above" is not allowed in single-best-answer drills.',
      category: 'range',
    });
  }
  const correct = q?.correct;
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
    violations.push({
      code: 'BAD_CORRECT_INDEX',
      message: 'The correct-answer index does not point at a valid option.',
      category: 'range',
    });
  }
  return violations;
}

/**
 * Validate a single flashcard's shape (front + back present and non-trivial).
 * @param {{ front?: string, back?: string }} c
 * @returns {GateViolation[]}
 */
export function checkFlashcardSanity(c) {
  const violations = [];
  if (typeof c?.front !== 'string' || c.front.trim().length < 3) {
    violations.push({ code: 'EMPTY_FRONT', message: 'Flashcard front is empty or trivial.', category: 'shape' });
  }
  if (typeof c?.back !== 'string' || c.back.trim().length < 3) {
    violations.push({ code: 'EMPTY_BACK', message: 'Flashcard back is empty or trivial.', category: 'shape' });
  }
  return violations;
}

/**
 * Run the universal content gate on one generated item.
 *
 * @param {object} params
 * @param {'mcq'|'flashcard'} params.kind
 * @param {object} params.value                 - the generated item
 * @param {string} [params.context]             - grounding source text (curriculum)
 * @param {number} [params.groundednessThreshold]
 * @param {(content: string, context: string) => number} [params.groundednessFn]
 *        - SEAM: override the default heuristic (RAG-4 / GAP-ENTAIL-1).
 * @returns {GateResult}
 */
export function runContentGate({
  kind,
  value,
  context = '',
  groundednessThreshold = DEFAULT_GROUNDEDNESS_THRESHOLD,
  groundednessFn = tokenOverlapGroundedness,
}) {
  const violations = [];
  // Assigned in every non-throwing branch below (mcq / flashcard); the `else`
  // throws, so no read can observe an unassigned value.
  let contentForGrounding;

  if (kind === 'mcq') {
    violations.push(...checkMcqSanity(value));
    const opts = Array.isArray(value?.options) ? value.options.join(' ') : '';
    contentForGrounding = `${value?.question ?? ''} ${opts}`;
  } else if (kind === 'flashcard') {
    violations.push(...checkFlashcardSanity(value));
    contentForGrounding = `${value?.front ?? ''} ${value?.back ?? ''}`;
  } else {
    throw new TypeError(`runContentGate: unknown kind "${kind}".`);
  }

  // Groundedness only when a context was supplied (otherwise the heuristic
  // returns 1 and this is a no-op — preserves callers that don't ground).
  if (context && String(context).trim()) {
    const score = groundednessFn(contentForGrounding, context);
    if (score < groundednessThreshold) {
      violations.push({
        code: 'UNGROUNDED',
        message: `Generated content is not grounded in the source (overlap ${score.toFixed(2)} < ${groundednessThreshold}).`,
        category: 'grounding',
      });
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations, quarantined: true };
  }
  return { ok: true, value, violations: [] };
}

/**
 * Convenience: run the gate over an array, returning the accepted items plus a
 * quarantine bucket. Used by the question/flashcard generators so a single bad
 * item doesn't poison the whole batch.
 *
 * @param {object} params
 * @param {'mcq'|'flashcard'} params.kind
 * @param {object[]} params.items
 * @param {string} [params.context]
 * @param {number} [params.groundednessThreshold]
 * @param {(content: string, context: string) => number} [params.groundednessFn]
 * @returns {{ accepted: object[], quarantined: Array<{ value: object, violations: GateViolation[] }> }}
 */
export function gateBatch({ kind, items, context = '', groundednessThreshold, groundednessFn }) {
  const accepted = [];
  const quarantined = [];
  for (const item of Array.isArray(items) ? items : []) {
    const result = runContentGate({ kind, value: item, context, groundednessThreshold, groundednessFn });
    if (result.ok) accepted.push(result.value);
    else quarantined.push({ value: item, violations: result.violations });
  }
  return { accepted, quarantined };
}
