#!/usr/bin/env node
/*
 * RAG-1 — offline retrieval-eval harness (StudyVault Wave 2, Measurement Substrate).
 *
 * Why this exists
 * ---------------
 * The RAG roadmap (Wave 5) keeps promising "better grounding". This harness makes
 * that PROVABLE: it runs the host's OWN BM25/cosine/hybrid ranking over a tiny,
 * hand-curated golden corpus + relevance judgments and computes the standard IR
 * metrics — recall@k, precision@k, MRR, nDCG@k. The floor below is seeded from the
 * harness's CURRENT numbers, so this is a NON-REGRESSION gate (retrieval may only
 * get better or stay flat), not an aspiration.
 *
 * Fully OFFLINE + deterministic: no sidecar, no LLM, no IndexedDB. The ranking
 * math is imported from src/lib/rag/ragEval.ts (which mirrors dexieDriver.ts's
 * chunk search) via the repo's register-ts-loader pattern; the fixtures are flat
 * JSON read off disk.
 *
 * Usage:
 *   node --import ./scripts/register-ts-loader.mjs scripts/rag-eval.mjs           # table + gate
 *   node --import ./scripts/register-ts-loader.mjs scripts/rag-eval.mjs --json    # machine-readable summary
 *   node --import ./scripts/register-ts-loader.mjs scripts/rag-eval.mjs --k 3     # evaluate at a different k
 *
 * Exit codes: 0 = all metrics at/above floor; 1 = at least one metric below floor;
 * 2 = the harness itself could not run (missing fixture, read/parse error).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFixture, checkFloor } from '../src/lib/rag/ragEval.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'rag-fixtures');

// ---------------------------------------------------------------------------
// FLOOR — seeded from the harness's own current numbers (k=5) with a small
// safety margin so it never flaps on float noise. These are the values
// `evaluateFixture(..., 5)` produces today over the committed fixtures:
//   recall=1.0  precision≈0.22778  mrr≈0.95833  ndcg≈0.96924
// To RAISE the bar after a retrieval improvement, bump these (and document why).
// To CHANGE the fixtures, re-run `node ... scripts/rag-eval.mjs` and re-seed.
// ---------------------------------------------------------------------------
export const FLOOR_K = 5;
export const FLOOR = {
  recall: 1.0,
  precision: 0.227,
  mrr: 0.95,
  ndcg: 0.96,
};

function loadFixture() {
  let corpusRaw;
  let queriesRaw;
  try {
    corpusRaw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'corpus.json'), 'utf8'));
    queriesRaw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'queries.json'), 'utf8'));
  } catch (err) {
    console.error(`rag-eval: could not load fixtures from ${FIXTURE_DIR}\n  ${err.message}`);
    process.exit(2);
  }
  const chunks = Array.isArray(corpusRaw.chunks) ? corpusRaw.chunks : [];
  const queries = Array.isArray(queriesRaw.queries) ? queriesRaw.queries : [];
  if (chunks.length === 0 || queries.length === 0) {
    console.error('rag-eval: fixtures are empty (need at least one chunk and one query).');
    process.exit(2);
  }
  return { chunks, queries };
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n) {
  return n.toFixed(4);
}

function parseK(argv) {
  const idx = argv.indexOf('--k');
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return FLOOR_K;
}

function printTable(report) {
  const { perQuery, aggregate } = report;
  const idW = Math.max(8, ...perQuery.map((r) => r.queryId.length));
  const head =
    `${'query'.padEnd(idW)}  ${'rel'.padStart(3)}  ${'recall'.padStart(7)}  ` +
    `${'prec'.padStart(7)}  ${'rr'.padStart(7)}  ${'ndcg'.padStart(7)}`;
  console.log(`\nRAG retrieval eval — k=${aggregate.k}, ${aggregate.queryCount} queries\n`);
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of perQuery) {
    console.log(
      `${r.queryId.padEnd(idW)}  ${String(r.relevantCount).padStart(3)}  ` +
        `${fmt(r.recall).padStart(7)}  ${fmt(r.precision).padStart(7)}  ` +
        `${fmt(r.mrr).padStart(7)}  ${fmt(r.ndcg).padStart(7)}`,
    );
  }
  console.log('-'.repeat(head.length));
  console.log(
    `${'MEAN'.padEnd(idW)}  ${''.padStart(3)}  ${fmt(aggregate.recall).padStart(7)}  ` +
      `${fmt(aggregate.precision).padStart(7)}  ${fmt(aggregate.mrr).padStart(7)}  ` +
      `${fmt(aggregate.ndcg).padStart(7)}`,
  );
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const k = parseK(argv);

  const fixture = loadFixture();
  const report = evaluateFixture(fixture, k);
  const agg = report.aggregate;

  // The floor is calibrated at FLOOR_K; only gate when evaluating at that k.
  const floorApplies = k === FLOOR_K;
  const violations = floorApplies ? checkFloor(agg, FLOOR) : [];
  const pass = violations.length === 0;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          k,
          floorK: FLOOR_K,
          floorApplies,
          floor: FLOOR,
          aggregate: agg,
          perQuery: report.perQuery,
          violations,
          pass,
        },
        null,
        2,
      ),
    );
  } else {
    printTable(report);
    console.log(
      `\nMean: recall@${k}=${pct(agg.recall)}  precision@${k}=${pct(agg.precision)}  ` +
        `MRR=${fmt(agg.mrr)}  nDCG@${k}=${fmt(agg.ndcg)}`,
    );
    if (!floorApplies) {
      console.log(
        `\nrag-eval: floor is calibrated at k=${FLOOR_K}; ran at k=${k}, so the gate is informational only.`,
      );
    } else if (pass) {
      console.log(
        `\nrag-eval: PASS — all metrics at/above the seeded floor ` +
          `(recall>=${FLOOR.recall}, precision>=${FLOOR.precision}, mrr>=${FLOOR.mrr}, ndcg>=${FLOOR.ndcg}).`,
      );
    } else {
      console.error('\nrag-eval: FAIL — retrieval quality regressed below the floor:');
      for (const v of violations) {
        console.error(`  ${v.metric}@${k}: ${fmt(v.actual)} < floor ${v.floor}`);
      }
      console.error(
        '\nRetrieval got WORSE than the committed baseline. Either a ranking change ' +
          'regressed quality (fix it), or this is an intentional, justified trade-off ' +
          '(re-seed FLOOR in scripts/rag-eval.mjs + src/lib/rag/ragEval.test.ts and say why).',
      );
    }
  }

  process.exit(pass ? 0 : 1);
}

main();
