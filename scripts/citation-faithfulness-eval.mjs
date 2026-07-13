#!/usr/bin/env node
/*
 * Wave 8 citation-faithfulness floor.
 *
 * Deterministic/offline release gate for the RAG-4 verifier: cited claims that
 * are supported by their cited chunk must pass, unsupported cited claims must
 * fail, and uncited prose must not create phantom grounding evidence.
 */
import { verifyAnswerCitations } from '../src/lib/localRag.ts';

const numbered = [
  {
    number: 1,
    chunk: {
      id: 'fixture-convexity',
      documentId: 'fixture',
      domain: 'cfa',
      text: 'Convexity captures the curvature of the price-yield relationship for bonds.',
      locator: 'fixture:1',
      score: 1,
    },
  },
];

async function runCase(name, answer, predicate) {
  const results = await verifyAnswerCitations(answer, numbered, { useLlm: false });
  const ok = Boolean(predicate(results));
  return { name, ok, results };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const cases = [
    await runCase(
      'supported_cited_claim_passes',
      'Convexity captures curvature in the price-yield relationship [1].',
      (rows) => rows.length === 1 && rows[0].entailed === true,
    ),
    await runCase(
      'unsupported_cited_claim_fails',
      'XLOOKUP returns a matching value from a result array [1].',
      (rows) => rows.length === 1 && rows[0].entailed === false,
    ),
    await runCase(
      'uncited_sentence_is_not_verified',
      'Convexity captures curvature [1]. This uncited sentence is ignored.',
      (rows) => rows.length === 1,
    ),
    await runCase(
      'missing_citation_number_fails',
      'Convexity captures curvature [99].',
      (rows) => rows.length === 1 && rows[0].number === 99 && rows[0].entailed === false,
    ),
    await runCase(
      'no_marker_answer_has_no_verified_claims',
      'Convexity captures curvature without a citation marker.',
      (rows) => rows.length === 0,
    ),
  ];
  const pass = cases.every((c) => c.ok);
  const payload = {
    schema: 'studyvault.citation-faithfulness-eval.v1',
    pass,
    cases,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (pass) {
    console.log(`citation-faithfulness-eval: PASS (${cases.length} cases)`);
  } else {
    console.error('citation-faithfulness-eval: FAIL');
    for (const c of cases.filter((row) => !row.ok)) {
      console.error(`  ${c.name}`);
    }
  }
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`citation-faithfulness-eval: ERROR ${err?.stack || err}`);
  process.exit(2);
});
