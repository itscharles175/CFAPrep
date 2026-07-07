#!/usr/bin/env node
/*
 * Offline prompt-regression floor for host/CFA prompt surfaces.
 *
 * The floor snapshots prompt registry renders and captured chat request bodies
 * with fixed inputs. It performs no model/network call; fetch is stubbed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  critiqueConstructedResponse,
  explainWrongAnswer,
  generateFlashcardsFromCurriculum,
  generateQuestionsFromCurriculum,
  gradeConstructedResponseStructured,
  narrateStudyPlan,
  summarizeTopicFromCurriculum,
} from '../src/lib/localLlm.js';
import { listPromptIds, renderPrompt } from '../src/lib/llm/promptRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.join(REPO_ROOT, 'tests', 'prompt-fixtures', 'prompt-regression.json');
const SCHEMA = 'studyvault.host-prompt-regression.v1';
const SETTINGS = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture-model', contextWindow: 8192 };
const CONTEXT = [
  'Modified duration measures bond price sensitivity to yield changes.',
  'Convexity captures curvature in the price-yield relationship.',
].join(' ');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function display(value) {
  return JSON.stringify(stable(value), null, 2);
}

function jsonResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function captureFetch(call, content) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    });
    return jsonResponse(content);
  };
  try {
    const result = await call();
    if (requests.length !== 1) {
      throw new Error(`Expected exactly one captured fetch; saw ${requests.length}.`);
    }
    return { request: requests[0], result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function registryContracts() {
  const vars = {
    'cfa.questions': { topicTitle: 'Fixed Income', count: 2, context: 'Duration and convexity excerpts.' },
    'cfa.flashcards': { topicTitle: 'Fixed Income', count: 2, context: 'Duration and convexity excerpts.' },
    'cfa.rubricGrade': {
      prompt: 'Explain modified duration for a liability-driven portfolio.',
      criteriaBlock: '  - id: "duration", label: "Duration definition", max 2 pts',
      response: 'Modified duration measures price sensitivity when yields change.',
    },
  };
  return listPromptIds().sort().map((id) => {
    const rendered = renderPrompt(id, vars[id]);
    return {
      id: `host.registry.${id}`,
      value: {
        id: rendered.id,
        version: rendered.version,
        schemaName: rendered.schemaName,
        system: rendered.system,
        user: rendered.user,
        jsonSchema: rendered.jsonSchema,
      },
    };
  });
}

async function requestContracts() {
  const contracts = [];
  const questionCapture = await captureFetch(
    () => generateQuestionsFromCurriculum({
      settings: SETTINGS,
      topicTitle: 'Fixed Income',
      chunks: [{ locator: 'fixture:duration', text: CONTEXT }],
      count: 1,
    }),
    JSON.stringify([
      {
        question: 'What does modified duration measure for a bond?',
        options: ['Bond price sensitivity to yield changes', 'Coupon payment timing', 'Issuer tax rate'],
        correct: 0,
        explanation: 'Modified duration measures price sensitivity.',
      },
    ]),
  );
  contracts.push({
    id: 'host.request.cfa.questions',
    value: {
      request: questionCapture.request,
      promptVersions: questionCapture.result.map((row) => row.prompt_version),
    },
  });

  const flashcardCapture = await captureFetch(
    () => generateFlashcardsFromCurriculum({
      settings: SETTINGS,
      topicTitle: 'Fixed Income',
      chunks: [{ locator: 'fixture:duration', text: CONTEXT }],
      count: 1,
    }),
    JSON.stringify([
      {
        front: 'What does modified duration measure?',
        back: 'Bond price sensitivity to yield changes.',
        locator: 'fixture:duration',
      },
    ]),
  );
  contracts.push({
    id: 'host.request.cfa.flashcards',
    value: {
      request: flashcardCapture.request,
      promptVersions: flashcardCapture.result.map((row) => row.prompt_version),
    },
  });

  const gradeCapture = await captureFetch(
    () => gradeConstructedResponseStructured({
      settings: SETTINGS,
      prompt: 'Explain modified duration for a liability-driven portfolio.',
      response: 'Modified duration measures price sensitivity when yields change.',
      rubric: [{ id: 'duration', label: 'Duration definition', maxPoints: 2 }],
    }),
    JSON.stringify({
      criteria: [
        {
          id: 'duration',
          verdict: 'Met',
          score: 2,
          evidence: 'The response states price sensitivity.',
          improvement: 'Mention the yield denominator adjustment.',
        },
      ],
      summary: 'Solid duration definition.',
    }),
  );
  contracts.push({ id: 'host.request.cfa.rubricGrade', value: gradeCapture.request });

  const explainCapture = await captureFetch(
    () => explainWrongAnswer({
      settings: SETTINGS,
      question: 'What is modified duration?',
      options: ['Credit risk', 'Macaulay duration', 'Macaulay duration divided by one plus yield'],
      correctIndex: 2,
      userIndex: 1,
      baseExplanation: 'Modified duration adjusts Macaulay duration for yield.',
    }),
    'The correct option adjusts Macaulay duration for yield.',
  );
  contracts.push({ id: 'host.request.cfa.explainWrongAnswer', value: explainCapture.request });

  const critiqueCapture = await captureFetch(
    () => critiqueConstructedResponse({
      settings: SETTINGS,
      prompt: 'Recommend an asset allocation for a retiree.',
      response: 'I would allocate 70% equities for growth.',
      rubric: [
        { id: 'c1', label: 'Asset allocation rationale', maxPoints: 3 },
        { id: 'c2', label: 'Risk factor identification', maxPoints: 2, description: 'Name at least two risk factors.' },
      ],
    }),
    'c1: Partial. c2: Missed.',
  );
  contracts.push({ id: 'host.request.cfa.critiqueConstructedResponse', value: critiqueCapture.request });

  const narrativeCapture = await captureFetch(
    () => narrateStudyPlan({
      settings: SETTINGS,
      plan: {
        headline: 'Duration review',
        dueCount: 4,
        weakCount: 2,
        peakReviewDay: { date: '2026-07-07', count: 9 },
        actions: [
          { kind: 'review', title: 'Modified duration', reason: 'Weak recent recall' },
          { kind: 'drill', title: 'Convexity questions', reason: 'Upcoming exam weight' },
        ],
      },
    }),
    'Start with duration, then drill convexity.',
  );
  contracts.push({ id: 'host.request.cfa.narrateStudyPlan', value: narrativeCapture.request });

  const summaryCapture = await captureFetch(
    () => summarizeTopicFromCurriculum({
      settings: SETTINGS,
      topicTitle: 'Fixed Income',
      chunks: [{ locator: 'fixture:duration', text: CONTEXT }],
    }),
    'Modified duration measures bond price sensitivity to yield changes.',
  );
  contracts.push({ id: 'host.request.cfa.summarizeTopicFromCurriculum', value: summaryCapture.request });

  return contracts;
}

async function renderHostPromptContracts() {
  return [...registryContracts(), ...(await requestContracts())];
}

function loadFixture(fixturePath) {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

async function runPromptFloor(fixturePath = DEFAULT_FIXTURE) {
  const fixture = loadFixture(fixturePath);
  const expected = new Map((fixture.host?.prompts || []).map((row) => [row.id, row]));
  const rendered = await renderHostPromptContracts();
  const cases = rendered.map((row) => {
    const exp = expected.get(row.id);
    const actualHash = sha256(row.value);
    const haystack = display(row.value);
    const missingRequired = (exp?.required || []).filter((token) => !haystack.includes(token));
    return {
      id: row.id,
      ok: Boolean(exp) && exp.sha256 === actualHash && missingRequired.length === 0,
      sha256: actualHash,
      expected_sha256: exp?.sha256,
      missing_fixture: !exp,
      missing_required: missingRequired,
    };
  });
  const renderedIds = new Set(rendered.map((row) => row.id));
  for (const id of [...expected.keys()].filter((id) => !renderedIds.has(id)).sort()) {
    cases.push({
      id,
      ok: false,
      sha256: null,
      expected_sha256: expected.get(id)?.sha256,
      missing_renderer: true,
      missing_required: [],
    });
  }
  return {
    schema: SCHEMA,
    pass: cases.every((row) => row.ok),
    fixture: fixturePath,
    cases,
  };
}

async function dumpCurrent() {
  return {
    schema: SCHEMA,
    prompts: (await renderHostPromptContracts()).map((row) => ({
      id: row.id,
      sha256: sha256(row.value),
    })),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const fixtureFlag = process.argv.findIndex((arg) => arg === '--fixture');
  const fixturePath = fixtureFlag >= 0 ? path.resolve(process.argv[fixtureFlag + 1]) : DEFAULT_FIXTURE;
  const payload = args.has('--dump') ? await dumpCurrent() : await runPromptFloor(fixturePath);
  if (args.has('--json') || args.has('--dump')) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.pass) {
    console.log(`host prompt-regression fixture floor: PASS (${payload.cases.length} cases)`);
  } else {
    console.error('host prompt-regression fixture floor: FAIL');
    for (const row of payload.cases.filter((entry) => !entry.ok)) {
      console.error(`  ${row.id}`);
    }
  }
  process.exit((payload.pass ?? true) ? 0 : 1);
}

main().catch((err) => {
  console.error(`host prompt-regression fixture floor: ERROR ${err?.stack || err}`);
  process.exit(2);
});
