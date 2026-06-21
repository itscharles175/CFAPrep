// AI-3 — host prompt + schema registry.
//
// The host's structured generators historically hard-coded their system/user
// prompts inline in localLlm.js. That made prompts un-addressable (no version to
// stamp onto generated content), un-snapshottable (silent drift), and impossible
// to share with the backend or an eval harness.
//
// This registry is the single source of truth for every STRUCTURED host prompt:
//
//     id -> { version, system, user(vars), schema, jsonSchema, schemaName }
//
//   - `version`   : bump on ANY change to system/user/schema. Stamp it onto
//                   generated content as `prompt_version` so a learner's saved
//                   item records which prompt produced it (eval reproducibility).
//   - `system`    : the system prompt (static string).
//   - `user(vars)`: pure function rendering the user message from variables.
//   - `schema`    : the zod validator for the model's structured output.
//   - `jsonSchema`: a plain JSON Schema for `response_format` (wire-level
//                   constraint where the server supports it).
//   - `schemaName`: response_format schema name.
//
// Creative/streaming prompts (explain, critique, narrate) are NOT registered
// here — they produce free prose, not schema-bound JSON, and keep their inline
// literals. Only the validate-then-gate generators are migrated.
//
// The golden-anchored regression test (promptRegistry.test.js) snapshots the
// rendered SHAPE of every registered prompt so prompt drift is caught in CI,
// offline, with no model call.

import { z } from 'zod';

// ── shared schemas ──────────────────────────────────────────────────────────

// One MCQ. `correct` is a 0-based index; the content gate (AI-2) re-checks it
// against the actual option count, so the schema only enforces "non-negative
// integer" here. options: >=2 enforced at the array level.
const McqSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  correct: z.number().int().nonnegative(),
  explanation: z.string().optional().default(''),
});

const QuestionsSchema = z.array(McqSchema).min(1);

const FlashcardSchema = z.object({
  front: z.string().min(1),
  back: z.string().min(1),
  locator: z.string().optional(),
});

const FlashcardsSchema = z.array(FlashcardSchema).min(1);

const RubricGradeSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        verdict: z.string().min(1),
        score: z.number(),
        evidence: z.string().optional().default(''),
        improvement: z.string().optional().default(''),
      }),
    )
    .default([]),
  summary: z.string().optional().default(''),
});

// ── JSON Schemas (wire-level response_format constraints) ────────────────────
// Plain JSON Schema mirrors of the zod schemas above. Kept hand-written (rather
// than auto-derived) so the exact wire contract is explicit and reviewable.

const mcqJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'options', 'correct'],
  properties: {
    question: { type: 'string' },
    options: { type: 'array', minItems: 2, items: { type: 'string' } },
    correct: { type: 'integer', minimum: 0 },
    explanation: { type: 'string' },
  },
};

const questionsJsonSchema = { type: 'array', minItems: 1, items: mcqJsonSchema };

const flashcardJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['front', 'back'],
  properties: {
    front: { type: 'string' },
    back: { type: 'string' },
    locator: { type: 'string' },
  },
};

const flashcardsJsonSchema = { type: 'array', minItems: 1, items: flashcardJsonSchema };

const rubricGradeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'score'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string' },
          score: { type: 'number' },
          evidence: { type: 'string' },
          improvement: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

export const PROMPTS = Object.freeze({
  'cfa.questions': {
    id: 'cfa.questions',
    version: 1,
    schemaName: 'cfa_questions',
    schema: QuestionsSchema,
    jsonSchema: questionsJsonSchema,
    system:
      'You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write exam-style practice multiple-choice questions. ' +
      'Respond with a JSON array and nothing else. Each element must be an object: ' +
      '{"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.',
    /**
     * @param {{ topicTitle: string, count: number, context: string }} vars
     */
    user: ({ topicTitle, count, context }) =>
      `Topic: ${topicTitle}\n\nWrite ${count} questions grounded strictly in these excerpts:\n\n${context}`,
  },

  'cfa.flashcards': {
    id: 'cfa.flashcards',
    version: 1,
    schemaName: 'cfa_flashcards',
    schema: FlashcardsSchema,
    jsonSchema: flashcardsJsonSchema,
    system:
      'You are a CFA tutor. Using ONLY the provided curriculum excerpts, write concise flashcards. ' +
      'Front = a focused prompt (definition / formula / scenario). ' +
      'Back = a precise 1-3 sentence answer + a citation locator if obvious from the excerpts. ' +
      'Respond with a JSON array — no prose.',
    /**
     * @param {{ topicTitle: string, count: number, context: string }} vars
     */
    user: ({ topicTitle, count, context }) =>
      `Topic: ${topicTitle}\n\nWrite ${count} flashcards grounded strictly in these excerpts:\n\n${context}`,
  },

  'cfa.rubricGrade': {
    id: 'cfa.rubricGrade',
    version: 1,
    schemaName: 'cfa_rubric_grade',
    schema: RubricGradeSchema,
    jsonSchema: rubricGradeJsonSchema,
    system:
      'You are a CFA Level III rubric grader. Return ONLY a JSON object — no prose, no markdown fences. Shape:\n' +
      '{\n' +
      '  "criteria": [\n' +
      '    { "id": "<rubric id>", "verdict": "Met"|"Partial"|"Missed", "score": <number ≤ maxPoints>, "evidence": "<1-2 sentences grounded in the candidate text>", "improvement": "<one concrete suggestion>" }\n' +
      '  ],\n' +
      '  "summary": "<2-3 sentences on the overall response — what was strong, what was the biggest weakness>"\n' +
      '}\n' +
      'Score conservatively — Level III graders do not inflate. Met = full credit, Partial = at most 60% of maxPoints, Missed = 0.',
    /**
     * @param {{ prompt: string, criteriaBlock: string, response: string }} vars
     */
    user: ({ prompt, criteriaBlock, response }) =>
      `Prompt:\n${prompt}\n\nRubric criteria:\n${criteriaBlock}\n\nCandidate response:\n${response}\n\nReturn the JSON now.`,
  },
});

/**
 * Look up a registered prompt by id. Throws on an unknown id so a typo fails
 * loudly at the call site rather than silently sending an empty prompt.
 *
 * @param {string} id
 * @returns {typeof PROMPTS[keyof typeof PROMPTS]}
 */
export function getPrompt(id) {
  const entry = PROMPTS[id];
  if (!entry) throw new Error(`Unknown prompt id: "${id}".`);
  return entry;
}

/**
 * Render a registered prompt's messages + carry its schema metadata for the
 * structured engine. Returns everything a generator needs in one call so the
 * call site stays declarative.
 *
 * @param {string} id
 * @param {object} vars  - template variables for the user message
 * @returns {{
 *   id: string, version: number, schemaName: string,
 *   schema: import('zod').ZodTypeAny, jsonSchema: object,
 *   system: string, user: string,
 *   messages: Array<{ role: 'system'|'user', content: string }>,
 * }}
 */
export function renderPrompt(id, vars = {}) {
  const entry = getPrompt(id);
  const system = entry.system;
  const user = entry.user(vars);
  return {
    id: entry.id,
    version: entry.version,
    schemaName: entry.schemaName,
    schema: entry.schema,
    jsonSchema: entry.jsonSchema,
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

/** List every registered prompt id (stable order). */
export function listPromptIds() {
  return Object.keys(PROMPTS);
}

export { z };
