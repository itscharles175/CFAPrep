#!/usr/bin/env node
// Bulk-generate AI questions + flashcards for every (level, topic) combo that
// has ingested curriculum, using the user's LOCAL OpenAI-compatible model
// server (LM Studio at :1234/v1, Ollama at :11434/v1). Fully offline; we
// never reach out to anything except `localhost`.
//
// Pillar 10 (content breadth) — for Levels 2 and 3 the authored packs are
// thinner than Level 1. Rather than hand-authoring hundreds of items, this
// script lets the user pre-populate the AI-practice / AI-flashcards caches
// once from their own ingested curriculum so the in-app panels feel
// instantly populated rather than on-demand-only.
//
// Input: an already-built `.qvsource` bundle (the same one the app loads on
// first run from `public/cfa-source.qvsource`). The bundle carries the
// canonical chunks + topic classifications.
//
// Output: a `public/cfa-generated.json` companion bundle that the app's
// bootstrap reads and seeds into `db.settings` under the existing cache
// keys (`ai-questions:<level>:<topic>` and `flash-cards:<level>:<topic>`).
//
// Usage:
//   npm run content:expand -- [options]
//
// Options:
//   --bundle <path>     Path to .qvsource bundle (default: public/cfa-source.qvsource)
//   --out <path>        Output JSON path (default: public/cfa-generated.json)
//   --levels <list>     Comma-separated level ids (default: level1,level2,level3)
//   --questions <n>     Questions per topic (default: 5)
//   --flashcards <n>    Flashcards per topic (default: 8)
//   --base-url <url>    OpenAI-compatible chat URL (default: http://localhost:1234/v1)
//   --model <name>      Model id (default: gemma-4-e4b-it)
//   --temperature <t>   Sampling temperature (default: 0.3)
//   --concurrency <n>   Parallel topic-LLM calls (default: 1)
//   --skip-existing     Skip topics already present in the output file
//   --dry-run           Walk + summarize but don't call the LLM or write
//
// Environment:
//   QV_LLM_BASE_URL     Overrides --base-url
//   QV_LLM_MODEL        Overrides --model

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  bundle: 'public/cfa-source.qvsource',
  out: 'public/cfa-generated.json',
  levels: ['level1', 'level2', 'level3'],
  questions: 5,
  flashcards: 8,
  baseUrl: 'http://localhost:1234/v1',
  model: 'gemma-4-e4b-it',
  temperature: 0.3,
  concurrency: 1,
  skipExisting: false,
  dryRun: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--bundle') opts.bundle = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--levels') opts.levels = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--questions') opts.questions = Number(next());
    else if (arg === '--flashcards') opts.flashcards = Number(next());
    else if (arg === '--base-url') opts.baseUrl = next();
    else if (arg === '--model') opts.model = next();
    else if (arg === '--temperature') opts.temperature = Number(next());
    else if (arg === '--concurrency') opts.concurrency = Number(next());
    else if (arg === '--skip-existing') opts.skipExisting = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('npm run content:expand -- [options] (see header of script for full list)');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (process.env.QV_LLM_BASE_URL) opts.baseUrl = process.env.QV_LLM_BASE_URL;
  if (process.env.QV_LLM_MODEL) opts.model = process.env.QV_LLM_MODEL;
  return opts;
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    const parsed = JSON.parse(slice);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function callLlmChat({ baseUrl, model, temperature, system, user }) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Local model server responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

// Same prompt shape as src/lib/localLlm.js generateQuestionsFromCurriculum.
async function generateQuestions({ baseUrl, model, temperature, topicTitle, chunks, count }) {
  const context = chunks
    .map((chunk) => `[${chunk.locator || 'excerpt'}] ${chunk.text}`)
    .join('\n\n')
    .slice(0, 12000);
  const system =
    'You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write exam-style practice multiple-choice questions. ' +
    'Respond with a JSON array and nothing else. Each element must be an object: ' +
    '{"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.';
  const user = `Topic: ${topicTitle}\n\nWrite ${count} questions grounded strictly in these excerpts:\n\n${context}`;
  const content = await callLlmChat({ baseUrl, model, temperature, system, user });
  const parsed = extractJsonArray(content);
  if (!parsed) return [];
  return parsed
    .filter(
      (item) =>
        item &&
        typeof item.question === 'string' &&
        Array.isArray(item.options) &&
        item.options.length >= 2,
    )
    .map((item, index) => ({
      id: `ai-${index + 1}`,
      question: item.question,
      options: item.options.map((option) => String(option)),
      correct:
        Number.isInteger(item.correct) && item.correct >= 0 && item.correct < item.options.length
          ? item.correct
          : 0,
      explanation: typeof item.explanation === 'string' ? item.explanation : '',
    }));
}

// Same prompt shape as src/lib/localLlm.js generateFlashcardsFromCurriculum.
async function generateFlashcards({ baseUrl, model, temperature, topicTitle, chunks, count }) {
  const context = chunks
    .map((chunk) => `[${chunk.locator || 'excerpt'}] ${chunk.text}`)
    .join('\n\n')
    .slice(0, 12000);
  const system =
    'You are a CFA tutor. Using ONLY the provided curriculum excerpts, write concise flashcards. ' +
    'Front = a focused prompt (definition / formula / scenario). ' +
    'Back = a precise 1-3 sentence answer + a citation locator if obvious from the excerpts. ' +
    'Respond with a JSON array — no prose.';
  const user = `Topic: ${topicTitle}\n\nWrite ${count} flashcards grounded strictly in these excerpts:\n\n${context}`;
  const content = await callLlmChat({ baseUrl, model, temperature, system, user });
  const parsed = extractJsonArray(content);
  if (!parsed) return [];
  return parsed
    .filter((item) => item && typeof item.front === 'string' && typeof item.back === 'string' && item.front.trim() && item.back.trim())
    .map((item, index) => ({
      id: `flash-${index + 1}`,
      front: item.front,
      back: item.back,
      locator: typeof item.locator === 'string' ? item.locator : undefined,
    }));
}

function indexChunksByLevelAndTopic(bundle) {
  // Build { level: { topicId: chunk[] } } from a .qvsource bundle.
  const docLevelById = new Map();
  for (const doc of bundle.documents || []) {
    docLevelById.set(doc.id, doc.level || 'unknown');
  }
  const out = {};
  for (const chunk of bundle.chunks || []) {
    const level = docLevelById.get(chunk.documentId) || 'unknown';
    if (!out[level]) out[level] = {};
    for (const topicId of chunk.topicIds || []) {
      if (!out[level][topicId]) out[level][topicId] = [];
      out[level][topicId].push(chunk);
    }
  }
  // Cap each topic's chunk count — the prompts only carry the first slice.
  for (const level of Object.keys(out)) {
    for (const topicId of Object.keys(out[level])) {
      out[level][topicId].sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
      out[level][topicId] = out[level][topicId].slice(0, 14);
    }
  }
  return out;
}

const TOPIC_TITLES = {
  ethics: 'Ethics & Professional Standards',
  'quant-methods': 'Quantitative Methods',
  economics: 'Economics',
  fsa: 'Financial Statement Analysis',
  corporate: 'Corporate Issuers',
  equity: 'Equity Investments',
  'fixed-income': 'Fixed Income',
  derivatives: 'Derivatives',
  alternatives: 'Alternative Investments',
  portfolio: 'Portfolio Management',
  'asset-allocation': 'Asset Allocation',
  'portfolio-construction': 'Portfolio Construction',
  performance: 'Performance Measurement',
  'derivatives-risk': 'Derivatives and Risk Management',
  'pm-pathway': 'Portfolio Management Pathway',
  'private-markets-pathway': 'Private Markets Pathway',
  'private-wealth-pathway': 'Private Wealth Pathway',
};

function titleFor(topicId) {
  return TOPIC_TITLES[topicId] || topicId;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let bundle;
  try {
    bundle = JSON.parse(await readFile(opts.bundle, 'utf-8'));
  } catch (error) {
    console.error(`Could not read .qvsource bundle at ${opts.bundle}: ${error.message}`);
    process.exit(1);
  }

  const grouped = indexChunksByLevelAndTopic(bundle);
  const targetLevels = opts.levels.filter((id) => grouped[id]);

  // Load existing output if any so --skip-existing can preserve prior work.
  let prior = { generatedAt: null, byTopic: {} };
  if (opts.skipExisting) {
    try {
      const raw = await readFile(opts.out, 'utf-8');
      prior = JSON.parse(raw);
    } catch {
      prior = { generatedAt: null, byTopic: {} };
    }
  }

  // Plan
  const work = [];
  for (const level of targetLevels) {
    for (const topicId of Object.keys(grouped[level])) {
      const chunks = grouped[level][topicId];
      if (!chunks?.length) continue;
      const existing = opts.skipExisting && prior.byTopic?.[level]?.[topicId];
      if (existing?.questions?.length || existing?.flashcards?.length) continue;
      work.push({ level, topicId, chunks });
    }
  }

  console.log(`Plan: ${work.length} (level, topic) pairs across ${targetLevels.length} level(s).`);
  if (opts.dryRun) {
    for (const w of work) {
      console.log(`  ${w.level}/${w.topicId}: ${w.chunks.length} chunk(s)`);
    }
    return;
  }
  if (!work.length) {
    console.log('Nothing to do (--skip-existing matches everything). Exiting.');
    return;
  }

  const byTopic = { ...(prior.byTopic || {}) };
  for (const { level, topicId, chunks } of work) {
    const title = titleFor(topicId);
    console.log(`\n[${level}/${topicId}] generating ${opts.questions} questions + ${opts.flashcards} flashcards from ${chunks.length} chunk(s)…`);
    const t0 = Date.now();
    try {
      const [questions, flashcards] = await Promise.all([
        generateQuestions({
          baseUrl: opts.baseUrl,
          model: opts.model,
          temperature: opts.temperature,
          topicTitle: title,
          chunks,
          count: opts.questions,
        }),
        generateFlashcards({
          baseUrl: opts.baseUrl,
          model: opts.model,
          temperature: opts.temperature,
          topicTitle: title,
          chunks,
          count: opts.flashcards,
        }),
      ]);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `  → ${questions.length} questions, ${flashcards.length} flashcards in ${elapsed}s`,
      );
      byTopic[level] = byTopic[level] || {};
      byTopic[level][topicId] = {
        title,
        questions,
        flashcards,
        sourceChunkCount: chunks.length,
        generatedAt: new Date().toISOString(),
      };
      // Write after every topic so a long run can be killed without losing
      // earlier work.
      await mkdir(path.dirname(opts.out), { recursive: true });
      await writeFile(
        opts.out,
        JSON.stringify(
          {
            app: 'QuantVault',
            kind: 'cfa-generated-content',
            bundleVersion: 1,
            generatedAt: new Date().toISOString(),
            model: opts.model,
            baseUrl: opts.baseUrl,
            byTopic,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(`  ! ${level}/${topicId} failed: ${error.message}`);
    }
  }

  console.log(`\nDone. Wrote ${opts.out}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
