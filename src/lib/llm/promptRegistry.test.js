import { describe, expect, it } from 'vitest';
import {
  PROMPTS,
  getPrompt,
  listPromptIds,
  renderPrompt,
} from './promptRegistry';

describe('prompt registry — addressability + integrity', () => {
  it('registers the three structured host prompts', () => {
    expect(listPromptIds().sort()).toEqual(['cfa.flashcards', 'cfa.questions', 'cfa.rubricGrade']);
  });

  it('every entry is addressable, versioned, and carries a schema + jsonSchema', () => {
    for (const id of listPromptIds()) {
      const p = getPrompt(id);
      expect(p.id).toBe(id);
      expect(Number.isInteger(p.version)).toBe(true);
      expect(p.version).toBeGreaterThanOrEqual(1);
      expect(typeof p.system).toBe('string');
      expect(typeof p.user).toBe('function');
      expect(typeof p.schema?.safeParse).toBe('function');
      expect(p.jsonSchema && typeof p.jsonSchema).toBe('object');
      expect(typeof p.schemaName).toBe('string');
    }
  });

  it('throws loudly on an unknown id', () => {
    expect(() => getPrompt('does.not.exist')).toThrow(/Unknown prompt id/);
  });

  it('renderPrompt returns system/user messages + stampable version metadata', () => {
    const r = renderPrompt('cfa.questions', { topicTitle: 'Fixed Income', count: 3, context: 'EXCERPTS' });
    expect(r.id).toBe('cfa.questions');
    expect(r.version).toBe(PROMPTS['cfa.questions'].version);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[1].role).toBe('user');
    expect(r.user).toContain('Fixed Income');
    expect(r.user).toContain('3');
    expect(r.user).toContain('EXCERPTS');
  });
});

// ── GOLDEN-ANCHORED REGRESSION ────────────────────────────────────────────────
// Snapshot the rendered SHAPE of each registered prompt with FIXED variables so
// any unintended drift to a system prompt or user template is caught in CI,
// offline, with no model call. When a prompt is intentionally edited: BUMP its
// `version` in promptRegistry.js, then update the golden below in the SAME commit.

const GOLDEN_VARS = {
  'cfa.questions': { topicTitle: '<TOPIC>', count: 2, context: '<CTX>' },
  'cfa.flashcards': { topicTitle: '<TOPIC>', count: 2, context: '<CTX>' },
  'cfa.rubricGrade': { prompt: '<PROMPT>', criteriaBlock: '<CRITERIA>', response: '<RESPONSE>' },
};

describe('golden prompt snapshots (drift guard)', () => {
  it('cfa.questions renders the anchored shape', () => {
    const r = renderPrompt('cfa.questions', GOLDEN_VARS['cfa.questions']);
    expect({ version: r.version, system: r.system, user: r.user }).toMatchInlineSnapshot(`
      {
        "system": "You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write exam-style practice multiple-choice questions. Respond with a JSON array and nothing else. Each element must be an object: {"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.",
        "user": "Topic: <TOPIC>

      Write 2 questions grounded strictly in these excerpts:

      <CTX>",
        "version": 1,
      }
    `);
  });

  it('cfa.flashcards renders the anchored shape', () => {
    const r = renderPrompt('cfa.flashcards', GOLDEN_VARS['cfa.flashcards']);
    expect({ version: r.version, system: r.system, user: r.user }).toMatchInlineSnapshot(`
      {
        "system": "You are a CFA tutor. Using ONLY the provided curriculum excerpts, write concise flashcards. Front = a focused prompt (definition / formula / scenario). Back = a precise 1-3 sentence answer + a citation locator if obvious from the excerpts. Respond with a JSON array — no prose.",
        "user": "Topic: <TOPIC>

      Write 2 flashcards grounded strictly in these excerpts:

      <CTX>",
        "version": 1,
      }
    `);
  });

  it('cfa.rubricGrade renders the anchored shape', () => {
    const r = renderPrompt('cfa.rubricGrade', GOLDEN_VARS['cfa.rubricGrade']);
    expect({ version: r.version, system: r.system, user: r.user }).toMatchInlineSnapshot(`
      {
        "system": "You are a CFA Level III rubric grader. Return ONLY a JSON object — no prose, no markdown fences. Shape:
      {
        "criteria": [
          { "id": "<rubric id>", "verdict": "Met"|"Partial"|"Missed", "score": <number ≤ maxPoints>, "evidence": "<1-2 sentences grounded in the candidate text>", "improvement": "<one concrete suggestion>" }
        ],
        "summary": "<2-3 sentences on the overall response — what was strong, what was the biggest weakness>"
      }
      Score conservatively — Level III graders do not inflate. Met = full credit, Partial = at most 60% of maxPoints, Missed = 0.",
        "user": "Prompt:
      <PROMPT>

      Rubric criteria:
      <CRITERIA>

      Candidate response:
      <RESPONSE>

      Return the JSON now.",
        "version": 1,
      }
    `);
  });
});
