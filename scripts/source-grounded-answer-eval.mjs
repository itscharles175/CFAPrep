#!/usr/bin/env node
/*
 * Wave 8 source-grounded answer benchmark floor.
 *
 * Deterministic/offline: evaluates hand-written CFA + LSAT answer fixtures
 * against their cited source chunks using the same RAG-4 citation verifier used
 * by localGroundedAnswer. No model, network, sidecar, or IndexedDB required.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyAnswerCitations } from '../src/lib/localRag.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const FIXTURE_PATH = join(REPO_ROOT, 'tests', 'rag-fixtures', 'source-grounded-answers.json');

const FLOORS = {
  minGroundedByDomain: { cfa: 2, lsat: 2 },
  minRejectedUnsupported: 1,
};

function loadFixture() {
  const payload = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  if (payload.schema !== 'studyvault.source-grounded-answer-fixture.v1') {
    throw new Error(`unexpected fixture schema: ${payload.schema}`);
  }
  if (!Array.isArray(payload.chunks) || !Array.isArray(payload.cases)) {
    throw new Error('fixture must contain chunks[] and cases[]');
  }
  const chunks = new Map(payload.chunks.map((chunk) => [chunk.id, chunk]));
  return { chunks, cases: payload.cases };
}

function includesTerm(answer, term) {
  return answer.toLowerCase().includes(String(term).toLowerCase());
}

function citationMarkers(answer) {
  return Array.from(answer.matchAll(/\[(\d+)\]/g)).map((match) => Number(match[1]));
}

function numberedCitations(testCase, chunks) {
  return testCase.citations.map((citation) => {
    const chunk = chunks.get(citation.chunkId);
    if (!chunk) throw new Error(`${testCase.id}: missing chunk ${citation.chunkId}`);
    return {
      number: citation.number,
      chunk: {
        id: chunk.id,
        documentId: chunk.documentId,
        domain: chunk.domain,
        text: chunk.text,
        locator: chunk.locator,
        score: 1,
      },
    };
  });
}

async function evaluateCase(testCase, chunks) {
  const numbered = numberedCitations(testCase, chunks);
  const markers = citationMarkers(testCase.answer);
  const verification = await verifyAnswerCitations(testCase.answer, numbered, { useLlm: false });
  const termsPresent = (testCase.requiredTerms ?? []).filter((term) =>
    includesTerm(testCase.answer, term),
  );
  const missingTerms = (testCase.requiredTerms ?? []).filter((term) =>
    !includesTerm(testCase.answer, term),
  );
  const hasCitationMarkers = markers.length > 0;
  const allCitedClaimsEntailed =
    verification.length > 0 && verification.every((row) => row.entailed === true);
  const grounded = hasCitationMarkers && allCitedClaimsEntailed && missingTerms.length === 0;
  const ok = testCase.expectGrounded ? grounded : !grounded;
  return {
    id: testCase.id,
    domain: testCase.domain,
    expectGrounded: testCase.expectGrounded,
    ok,
    grounded,
    hasCitationMarkers,
    termsPresent,
    missingTerms,
    verification,
  };
}

function summarize(results) {
  const groundedByDomain = {};
  let rejectedUnsupported = 0;
  for (const result of results) {
    if (result.expectGrounded && result.grounded) {
      groundedByDomain[result.domain] = (groundedByDomain[result.domain] ?? 0) + 1;
    }
    if (!result.expectGrounded && !result.grounded) {
      rejectedUnsupported += 1;
    }
  }
  const violations = [];
  for (const [domain, floor] of Object.entries(FLOORS.minGroundedByDomain)) {
    const actual = groundedByDomain[domain] ?? 0;
    if (actual < floor) {
      violations.push({ metric: `grounded_${domain}`, actual, floor });
    }
  }
  if (rejectedUnsupported < FLOORS.minRejectedUnsupported) {
    violations.push({
      metric: 'rejected_unsupported',
      actual: rejectedUnsupported,
      floor: FLOORS.minRejectedUnsupported,
    });
  }
  const failedCases = results.filter((result) => !result.ok).map((result) => result.id);
  for (const id of failedCases) {
    violations.push({ metric: 'case_failed', case: id });
  }
  return {
    caseCount: results.length,
    groundedByDomain,
    rejectedUnsupported,
    violations,
    pass: violations.length === 0,
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const { chunks, cases } = loadFixture();
  const results = [];
  for (const testCase of cases) {
    results.push(await evaluateCase(testCase, chunks));
  }
  const summary = summarize(results);
  const payload = {
    schema: 'studyvault.source-grounded-answer-eval.v1',
    floors: FLOORS,
    summary,
    cases: results,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (summary.pass) {
    console.log(
      `source-grounded-answer-eval: PASS (${summary.caseCount} cases, ` +
        `cfa=${summary.groundedByDomain.cfa ?? 0}, ` +
        `lsat=${summary.groundedByDomain.lsat ?? 0}, ` +
        `rejected=${summary.rejectedUnsupported})`,
    );
  } else {
    console.error('source-grounded-answer-eval: FAIL');
    for (const violation of summary.violations) {
      console.error(`  ${JSON.stringify(violation)}`);
    }
  }

  process.exit(summary.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`source-grounded-answer-eval: ERROR ${err?.stack || err}`);
  process.exit(2);
});
