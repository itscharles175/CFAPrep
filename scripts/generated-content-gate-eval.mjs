#!/usr/bin/env node
/*
 * Wave 8 generated-content quality floor.
 *
 * Deterministic/offline release gate for the shared content gate: valid
 * grounded content is accepted, malformed answer keys are quarantined, and
 * ungrounded generated content cannot enter the accepted bucket.
 */
import { gateBatch, runContentGate } from '../src/lib/llm/contentGate.js';
import { generateQuestionsFromCurriculum } from '../src/lib/localLlm.js';

const CONTEXT = [
  'Modified duration measures bond price sensitivity to yield changes.',
  'Convexity captures curvature in the price-yield relationship.',
].join(' ');

const goodMcq = {
  question: 'What does modified duration measure for a bond?',
  options: [
    'Bond price sensitivity to yield changes',
    'The coupon payment date',
    'The issuer tax rate',
  ],
  correct: 0,
};

const badIndexMcq = { ...goodMcq, correct: 99 };

const ungroundedMcq = {
  question: 'What does XLOOKUP return from a spreadsheet array?',
  options: ['A matching lookup value', 'A worksheet column result', 'A cell reference output'],
  correct: 0,
};

function hasCode(result, code) {
  return (result.violations || []).some((v) => v.code === code);
}

async function invalidAnswerIndexIsQuarantinedByGenerator() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  question: 'What does modified duration measure for a bond?',
                  options: ['Bond price sensitivity to yield changes', 'The coupon payment date'],
                  correct: 9,
                  explanation: 'Duration measures price sensitivity.',
                },
              ]),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const generated = await generateQuestionsFromCurriculum({
      settings: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model' },
      topicTitle: 'Fixed Income',
      chunks: [{ locator: 'fixture:duration', text: CONTEXT }],
      count: 1,
    });
    return { ok: generated.length === 0, result: { generated } };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const accepted = runContentGate({ kind: 'mcq', value: goodMcq, context: CONTEXT });
  const badIndex = runContentGate({ kind: 'mcq', value: badIndexMcq, context: CONTEXT });
  const ungrounded = runContentGate({ kind: 'mcq', value: ungroundedMcq, context: CONTEXT });
  const batch = gateBatch({ kind: 'mcq', items: [goodMcq, badIndexMcq, ungroundedMcq], context: CONTEXT });
  const generatorBadIndex = await invalidAnswerIndexIsQuarantinedByGenerator();
  const cases = [
    { name: 'grounded_mcq_accepted', ok: accepted.ok === true, result: accepted },
    { name: 'bad_answer_index_quarantined', ok: badIndex.ok === false && hasCode(badIndex, 'BAD_CORRECT_INDEX'), result: badIndex },
    { name: 'ungrounded_mcq_quarantined', ok: ungrounded.ok === false && hasCode(ungrounded, 'UNGROUNDED'), result: ungrounded },
    { name: 'batch_separates_accepted_and_quarantined', ok: batch.accepted.length === 1 && batch.quarantined.length === 2, result: batch },
    { name: 'generator_preserves_bad_answer_index_for_quarantine', ...generatorBadIndex },
  ];
  const pass = cases.every((c) => c.ok);
  const payload = {
    schema: 'studyvault.generated-content-gate-eval.v1',
    pass,
    cases,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (pass) {
    console.log(`generated-content-gate-eval: PASS (${cases.length} cases)`);
  } else {
    console.error('generated-content-gate-eval: FAIL');
    for (const c of cases.filter((row) => !row.ok)) {
      console.error(`  ${c.name}`);
    }
  }
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`generated-content-gate-eval: ERROR ${err?.stack || err}`);
  process.exit(2);
});
