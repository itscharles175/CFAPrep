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
//   --from-los <level>  Generate from published LOS rather than the .qvsource
//                       bundle. Use for L2/L3 where curriculum chunks aren't
//                       yet ingested. Reads scripts/cfa-l2-los-bank.mjs or
//                       scripts/cfa-l3-los-bank.mjs depending on level.
//
// Environment:
//   QV_LLM_BASE_URL     Overrides --base-url
//   QV_LLM_MODEL        Overrides --model

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  fromLos: null, // 'level2' | 'level3' when --from-los is supplied
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
    else if (arg === '--from-los') {
      const value = String(next() || '').trim();
      if (!/^level[23]$/.test(value)) {
        throw new Error(`--from-los expects level2 or level3, got: ${value || '(missing)'}`);
      }
      opts.fromLos = value;
    } else if (arg === '--help' || arg === '-h') {
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
  // Normalize key-case — Gemma frequently emits `Front` / `Back` (title-case)
  // rather than the lowercase the prompt asks for. Accept any combination.
  function pick(item, ...keys) {
    for (const k of keys) {
      if (typeof item?.[k] === 'string' && item[k].trim()) return item[k];
    }
    return null;
  }
  return parsed
    .map((item) => ({
      front: pick(item, 'front', 'Front', 'FRONT', 'question', 'Question'),
      back: pick(item, 'back', 'Back', 'BACK', 'answer', 'Answer'),
      locator: pick(item, 'locator', 'Locator', 'citation', 'Citation', 'page', 'Page'),
    }))
    .filter((item) => item.front && item.back)
    .map((item, index) => ({
      id: `flash-${index + 1}`,
      front: item.front,
      back: item.back,
      locator: typeof item.locator === 'string' ? item.locator : undefined,
    }));
}

// LOS-driven generation: derive questions + flashcards from a single learning
// outcome statement rather than a curriculum chunk. The LOS becomes the
// "locator" so chips render meaningfully (e.g. "LOS: Calculate the value of
// a forward contract").
function losLocator(losText) {
  const words = String(losText || '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  return words ? `LOS: ${words}` : 'LOS';
}

async function generateQuestionsFromLos({
  baseUrl,
  model,
  temperature,
  level,
  topicTitle,
  los,
  count,
  generate = callLlmChat,
}) {
  const levelLabel = level === 'level2' ? 'II' : level === 'level3' ? 'III' : String(level);
  const system =
    `You are a CFA Level ${levelLabel} exam writer. For the learning outcome statement (LOS) you are given, write exam-realistic ` +
    'multiple-choice questions that exercise the skill the LOS describes. ' +
    'Respond with a JSON array and nothing else. Each element must be an object: ' +
    '{"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.';
  const user =
    `Topic: ${topicTitle}\nLOS: ${los}\n\nWrite ${count} questions that an L${levelLabel} candidate ` +
    'would expect to see on this LOS. Anchor each question in the action verb and scope of the LOS.';
  const content = await generate({ baseUrl, model, temperature, system, user });
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
      locator: losLocator(los),
    }));
}

async function generateFlashcardsFromLos({
  baseUrl,
  model,
  temperature,
  level,
  topicTitle,
  los,
  count,
  generate = callLlmChat,
}) {
  const levelLabel = level === 'level2' ? 'II' : level === 'level3' ? 'III' : String(level);
  const system =
    `You are a CFA Level ${levelLabel} tutor. For the learning outcome statement (LOS) you are given, write concise flashcards. ` +
    'Front = a focused prompt (definition / formula / scenario) drawn from the LOS. ' +
    'Back = a precise 1-3 sentence answer. ' +
    'Respond with a JSON array — no prose.';
  const user =
    `Topic: ${topicTitle}\nLOS: ${los}\n\nWrite ${count} flashcards that drill the LOS.`;
  const content = await generate({ baseUrl, model, temperature, system, user });
  const parsed = extractJsonArray(content);
  if (!parsed) return [];
  function pick(item, ...keys) {
    for (const k of keys) {
      if (typeof item?.[k] === 'string' && item[k].trim()) return item[k];
    }
    return null;
  }
  const locator = losLocator(los);
  return parsed
    .map((item) => ({
      front: pick(item, 'front', 'Front', 'FRONT', 'question', 'Question'),
      back: pick(item, 'back', 'Back', 'BACK', 'answer', 'Answer'),
    }))
    .filter((item) => item.front && item.back)
    .map((item, index) => ({
      id: `flash-${index + 1}`,
      front: item.front,
      back: item.back,
      locator,
    }));
}

// Build a per-topic { questions, flashcards } entry for an LOS bank entry.
// Falls back to a 1-question / 1-flashcard stub if the local LLM is
// unreachable so the resulting JSON is still well-formed and the bootstrap
// always seeds something.
function stubQuestionFromLos(los) {
  return {
    id: 'ai-1',
    question: `Which of the following best describes how a candidate should "${los.toLowerCase()}"?`,
    options: [
      'Apply the framework directly as described in the LOS',
      'Ignore the LOS — it is informational only',
      'Substitute a different framework that is easier to compute',
    ],
    correct: 0,
    explanation:
      'STUB content — generated without a local model. A real --from-los run with LM Studio reachable will replace this with exam-realistic items grounded in the LOS.',
    locator: losLocator(los),
  };
}

function stubFlashcardFromLos(los) {
  return {
    id: 'flash-1',
    front: los,
    back: 'Apply this LOS in practice. STUB content — a real --from-los run will replace this with concise drill cards.',
    locator: losLocator(los),
  };
}

async function buildEntryFromLosTopic({
  topicEntry,
  level,
  questionsPerLos,
  flashcardsPerLos,
  maxQuestions,
  maxFlashcards,
  baseUrl,
  model,
  temperature,
  generate,
  log,
}) {
  const questions = [];
  const flashcards = [];
  let llmFailed = false;
  for (const los of topicEntry.learningOutcomes) {
    if (questions.length >= maxQuestions && flashcards.length >= maxFlashcards) break;
    let qs;
    let fs;
    try {
      [qs, fs] = await Promise.all([
        questions.length < maxQuestions
          ? generateQuestionsFromLos({
              baseUrl,
              model,
              temperature,
              level,
              topicTitle: topicEntry.title,
              los,
              count: questionsPerLos,
              generate,
            })
          : Promise.resolve([]),
        flashcards.length < maxFlashcards
          ? generateFlashcardsFromLos({
              baseUrl,
              model,
              temperature,
              level,
              topicTitle: topicEntry.title,
              los,
              count: flashcardsPerLos,
              generate,
            })
          : Promise.resolve([]),
      ]);
    } catch (error) {
      llmFailed = true;
      if (log) log(`    ! LOS call failed: ${error.message}`);
      break;
    }
    for (const item of qs) {
      if (questions.length >= maxQuestions) break;
      questions.push({ ...item, id: `ai-${questions.length + 1}` });
    }
    for (const item of fs) {
      if (flashcards.length >= maxFlashcards) break;
      flashcards.push({ ...item, id: `flash-${flashcards.length + 1}` });
    }
  }
  // Stub fallback if the LLM produced nothing for this topic.
  let stub = false;
  if (!questions.length) {
    stub = true;
    for (const los of topicEntry.learningOutcomes.slice(0, 1)) {
      questions.push(stubQuestionFromLos(los));
    }
  }
  if (!flashcards.length) {
    stub = true;
    for (const los of topicEntry.learningOutcomes.slice(0, 1)) {
      flashcards.push(stubFlashcardFromLos(los));
    }
  }
  return {
    questions,
    flashcards,
    source: stub ? (llmFailed ? 'los-stub' : 'los-empty-stub') : 'los',
  };
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

async function loadLosBank(level) {
  const fileName = level === 'level2' ? 'cfa-l2-los-bank.mjs' : 'cfa-l3-los-bank.mjs';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = path.join(here, fileName);
  const mod = await import(/* @vite-ignore */ `file://${target.replace(/\\/g, '/')}`);
  if (!Array.isArray(mod.default)) {
    throw new Error(`LOS bank ${fileName} did not export a default array`);
  }
  return mod.default;
}

async function runFromLos(opts) {
  const level = opts.fromLos;
  const bank = await loadLosBank(level);

  // Load existing output if any so we can merge into the same file.
  let prior;
  try {
    const raw = await readFile(opts.out, 'utf-8');
    prior = JSON.parse(raw);
  } catch {
    prior = { generatedAt: null, byTopic: {} };
  }

  const work = [];
  for (const entry of bank) {
    const existing = opts.skipExisting && prior.byTopic?.[level]?.[entry.topic];
    if (existing?.questions?.length || existing?.flashcards?.length) continue;
    work.push(entry);
  }

  console.log(
    `LOS plan: ${work.length} topic(s) for ${level} (max ${opts.questions} q + ${opts.flashcards} f per topic).`,
  );
  if (opts.dryRun) {
    for (const w of work) {
      console.log(`  ${level}/${w.topic}: ${w.learningOutcomes.length} LOS`);
    }
    return;
  }
  if (!work.length) {
    console.log('Nothing to do (--skip-existing matches everything). Exiting.');
    return;
  }

  // Probe the LLM with a lightweight noop generator if --base-url is
  // unreachable so we can quickly flip into stub mode for every topic without
  // burning the per-LOS retry budget.
  let generate = callLlmChat;
  try {
    await fetch(`${normalizeBaseUrl(opts.baseUrl)}/models`, { method: 'GET' });
  } catch (error) {
    console.log(`  (local LLM at ${opts.baseUrl} unreachable: ${error.message} — using stubs)`);
    generate = async () => '';
  }

  // Pick LOS-level fan-outs so that across ~6–10 LOS per topic we land near
  // the per-topic cap (`opts.questions`, `opts.flashcards`).
  const questionsPerLos = 2;
  const flashcardsPerLos = 2;

  const byTopic = { ...(prior.byTopic || {}) };
  for (const entry of work) {
    console.log(
      `\n[${level}/${entry.topic}] generating from ${entry.learningOutcomes.length} LOS …`,
    );
    const t0 = Date.now();
    const built = await buildEntryFromLosTopic({
      topicEntry: entry,
      level,
      questionsPerLos,
      flashcardsPerLos,
      maxQuestions: opts.questions,
      maxFlashcards: opts.flashcards,
      baseUrl: opts.baseUrl,
      model: opts.model,
      temperature: opts.temperature,
      generate,
      log: (msg) => console.log(msg),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  → ${built.questions.length} questions, ${built.flashcards.length} flashcards in ${elapsed}s (${built.source})`,
    );
    byTopic[level] = byTopic[level] || {};
    byTopic[level][entry.topic] = {
      title: entry.title,
      questions: built.questions,
      flashcards: built.flashcards,
      losCount: entry.learningOutcomes.length,
      source: built.source,
      generatedAt: new Date().toISOString(),
    };
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
  }
  const topicCount = Object.values(byTopic).reduce(
    (sum, lvl) => sum + Object.keys(lvl).length,
    0,
  );
  console.log(`\nDone. Wrote ${opts.out} (${topicCount} topic(s) total in bundle).`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.fromLos) {
    await runFromLos(opts);
    return;
  }

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

  const topicCount = Object.values(byTopic).reduce((sum, level) => sum + Object.keys(level).length, 0);
  if (topicCount > 0) {
    console.log(`\nDone. Wrote ${opts.out} (${topicCount} topic(s) generated).`);
  } else {
    console.log(`\nDone. No topics succeeded — check that the local model server is up and the model id is correct.`);
  }
}

// Only run main() when invoked as a CLI (not when imported by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  parseArgs,
  losLocator,
  buildEntryFromLosTopic,
  generateQuestionsFromLos,
  generateFlashcardsFromLos,
  stubQuestionFromLos,
  stubFlashcardFromLos,
  loadLosBank,
  runFromLos,
};
