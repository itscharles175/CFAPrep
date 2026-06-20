import { getStorage } from './storage';
import { packExcerpts, pickBudget, renderExcerpts } from './contextBudget';
import { streamSse, isStreamTimeout } from './streamingClient';

// Local-LLM integration. Targets an OpenAI-compatible chat endpoint exposed by a
// local model server (Ollama at :11434/v1, LM Studio at :1234/v1). No cloud, no
// API key — the app stays fully offline; this feature only lights up when the
// user's local server is running and configured.

const SETTINGS_KEY = 'local-llm';

// --- BB3: request dedup + cancellable timeout -----------------------------
//
// Two small reliability guards shared by every fetch-issuing helper below:
//
//   1. In-flight dedup. A double-clicked "Explain" (or two views racing the
//      same generation) should not double-hit the local sidecar. We key an
//      in-flight Map on a stable signature (endpoint + JSON of the salient
//      request params); identical CONCURRENT calls return the SAME promise,
//      and the entry is deleted as soon as that promise settles. This is a
//      best-effort coalescer for genuine in-flight overlap only — once a call
//      finishes the key is gone, so it is NOT a result cache.
//
//   2. Cancellable timeout. The local model can wedge indefinitely (model
//      crash, runaway generation). We race each fetch against a timer via an
//      AbortController. On timeout we abort the request and throw an Error
//      whose message clearly says "timed out" — DISTINCT from the existing
//      CORS / "Could not reach" / "responded NNN" strings other code matches
//      on. The caller's own AbortSignal (if any) is still honoured: aborting
//      it cancels the underlying fetch exactly as before.
//
// Both guards are additive — every existing export, call signature, and
// error-message string is preserved.

// Default timeouts (ms). Chat/explain-style calls are interactive; generation
// (questions / flashcards) is allowed to run longer.
export const LLM_TIMEOUT_CHAT_MS = 150000;
export const LLM_TIMEOUT_GENERATION_MS = 300000;

// signature -> Promise. Entry lives only for the duration of an in-flight call.
const inFlightRequests = new Map();

/**
 * Coalesce identical concurrent requests onto a single in-flight promise.
 * `signature` must be a stable string for "the same request". `run` performs
 * the actual work (fetch + decode + parse) and its resolved value is shared
 * by every concurrent caller with the same signature. The map entry is
 * removed as soon as the promise settles (resolve OR reject).
 */
function dedupeRequest(signature, run) {
  const existing = inFlightRequests.get(signature);
  if (existing) return existing;
  const promise = (async () => run())();
  inFlightRequests.set(signature, promise);
  // Delete on settle (either outcome). `.finally` keeps the original
  // resolution/rejection intact for callers awaiting `promise`.
  promise
    .finally(() => {
      // Guard against clobbering a newer in-flight promise that may have taken
      // this key after we settled (can only happen once we've been deleted, but
      // be defensive).
      if (inFlightRequests.get(signature) === promise) {
        inFlightRequests.delete(signature);
      }
    })
    // The `.finally` chain re-throws the original rejection on a NEW promise we
    // don't return. Callers get the real error via the returned `promise`, so
    // swallow it on this cleanup-only branch to avoid an unhandled rejection.
    .catch(() => {});
  return promise;
}

/**
 * Build a stable request signature from an endpoint URL and the salient
 * request params. JSON.stringify gives us a deterministic key for the bodies
 * we send (model + messages + temperature, etc.).
 */
function requestSignature(endpoint, salient) {
  let payload;
  try {
    payload = JSON.stringify(salient);
  } catch {
    // Non-serialisable params: fall back to a unique-ish key so we simply
    // skip coalescing rather than throwing.
    payload = `__nondeterministic__${Math.random()}`;
  }
  return `${endpoint}\n${payload}`;
}

/**
 * `fetch` wrapped with a cancellable timeout. Aborts the request after
 * `timeoutMs` and throws an Error flagged `isLlmTimeout` whose message clearly
 * mentions a timeout (distinct from the CORS / connection / status strings the
 * rest of this module already produces). A caller-supplied `callerSignal` is
 * still honoured — aborting it cancels the fetch and surfaces as the original
 * AbortError, exactly as before.
 *
 * @param {string} url
 * @param {RequestInit} init      - fetch init WITHOUT a `signal` (we own it)
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.callerSignal]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, { timeoutMs, callerSignal } = {}) {
  // If the caller already aborted, fail fast exactly like a normal aborted
  // fetch (its catch sites re-throw AbortError unchanged).
  if (callerSignal?.aborted) {
    const reason = callerSignal.reason;
    if (reason instanceof Error) throw reason;
    const aborted = new Error('The request was aborted.');
    aborted.name = 'AbortError';
    throw aborted;
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const seconds = Math.round((timeoutMs || 0) / 1000);
      const timeoutError = new Error(
        `Local model request timed out after ${seconds}s. The model may be overloaded or stuck — try again, pick a smaller model, or raise the limit.`,
        { cause: error },
      );
      timeoutError.isLlmTimeout = true;
      throw timeoutError;
    }
    // Caller-initiated abort (or a genuine network error): surface unchanged so
    // the existing AbortError / CORS handling downstream behaves as before.
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

export const DEFAULT_LLM_SETTINGS = {
  enabled: false,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1',
  /**
   * Optional explicit override for the model's context window.  When unset,
   * the budget is inferred from the model name (e.g. `-cw32768`,
   * `-ctx131072`, or a `128k` keyword) and falls back to 32768 — the
   * realistic LM Studio default for Gemma 4 E4B.  Setting this matters
   * when you've loaded a non-default window via `lms load -c <N>`.
   */
  contextWindow: 32768,
};

/**
 * Pack curriculum chunks into a string under the model's context budget.
 *
 * The default character-cap (`maxChars`) was previously a single hard-coded
 * 12000 across every caller; that worked for Gemma at 32K but silently
 * truncated long chunks under tighter loads (e.g. the 4K fallback we saw
 * after model crashes).  This shared helper consults `contextBudget` so
 * every caller gets the same deterministic budget per settings object.
 */
export function packCurriculumChunks(settings, chunks, opts = {}) {
  const budget = pickBudget({ modelName: settings?.model, contextWindow: settings?.contextWindow });
  // Reserve a slice of the user-and-grounding budget for the chunks
  // themselves; the rest stays available for the question / topic text.
  const groundingTokens = Math.max(512, Math.floor(budget.forUserAndGrounding * 0.75));
  const packed = packExcerpts(chunks || [], groundingTokens, (c) => c?.text || '');
  const rendered = renderExcerpts(packed.kept, (c) => c?.locator || (opts.defaultLocator ?? 'excerpt'), (c) => c?.text || '');
  return {
    text: rendered,
    keptCount: packed.kept.length,
    droppedCount: packed.dropped.length,
    tokens: packed.estimatedTokens,
    budget,
  };
}

export const LLM_PRESETS = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
];

export async function getLlmSettings() {
  try {
    const row = await getStorage().settings.get(SETTINGS_KEY);
    return { ...DEFAULT_LLM_SETTINGS, ...(row?.value || {}) };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export async function saveLlmSettings(settings) {
  const merged = { ...DEFAULT_LLM_SETTINGS, ...settings };
  await getStorage().settings.put({ key: SETTINGS_KEY, value: merged, updatedAt: new Date().toISOString() });
  return merged;
}

/** audit M11 — is this host a loopback or private-LAN address (i.e. safe to send
 *  prompts/source text to without breaking the offline/no-cloud promise)? A
 *  self-hosted model on another box on your LAN is fine; a public host is not. */
function isLocalLlmHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function normalizeBaseUrl(baseUrl) {
  const raw = (baseUrl || DEFAULT_LLM_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
  // audit M11 — the base URL is user-settable AND restored verbatim from a backup
  // (progressStore imports the settings store wholesale), so a crafted backup or
  // setting could otherwise redirect every generation — prompt + grounded source
  // text — to a REMOTE endpoint, silently breaking the offline/no-cloud promise.
  // Only loopback + private-LAN hosts may receive traffic; anything else falls
  // back to the safe localhost default (a public model server must be reached via
  // an explicit LAN IP, not a public host).
  try {
    const parsed = new URL(raw);
    if (!isLocalLlmHost(parsed.hostname)) {
      console.warn(
        `[localLlm] Ignoring non-local model endpoint "${raw}" — falling back to ${DEFAULT_LLM_SETTINGS.baseUrl} to preserve offline-only operation.`,
      );
      return DEFAULT_LLM_SETTINGS.baseUrl;
    }
  } catch {
    return DEFAULT_LLM_SETTINGS.baseUrl;
  }
  return raw;
}

export async function checkLlmConnection(settings) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  try {
    const response = await fetch(`${base}/models`, { method: 'GET' });
    if (!response.ok) return { ok: false, error: `Server responded ${response.status}` };
    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data.map((model) => model.id).filter(Boolean) : [];
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the local model server.' };
  }
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

export async function generateQuestionsFromCurriculum({ settings, topicTitle, chunks, count = 3, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const packed = packCurriculumChunks(settings, chunks);
  const context = packed.text;
  if (!context) throw new Error('No curriculum text available to ground generation.');

  const system =
    'You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write exam-style practice multiple-choice questions. ' +
    'Respond with a JSON array and nothing else. Each element must be an object: ' +
    '{"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.';
  const user = `Topic: ${topicTitle}\n\nWrite ${count} questions grounded strictly in these excerpts:\n\n${context}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_GENERATION_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      // Browser fetch to a different port is cross-origin. LM Studio and Ollama
      // both ship with CORS disabled by default; the fetch fails as a TypeError
      // long before any HTTP status. Make that fix actionable.
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. If you are using LM Studio, open its Developer / Server panel and enable CORS for "*" (then restart the server). For Ollama, start it with OLLAMA_ORIGINS=* set. The desktop (Tauri) shell does not need this — it calls the model natively.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonArray(content);
    if (!parsed) throw new Error('The model did not return parseable questions. Try a more capable local model.');

    return parsed
      .filter((item) => item && typeof item.question === 'string' && Array.isArray(item.options) && item.options.length >= 2)
      .map((item, index) => ({
        id: `ai-${index + 1}`,
        question: item.question,
        options: item.options.map((option) => String(option)),
        correct: Number.isInteger(item.correct) && item.correct >= 0 && item.correct < item.options.length ? item.correct : 0,
        explanation: typeof item.explanation === 'string' ? item.explanation : '',
      }));
  });
}

/**
 * Personalized explanation for a missed multiple-choice question.
 * Uses the local model to explain why the correct answer is right and the
 * user's choice is wrong — grounded by the question's existing explanation
 * (when present) so the model has something to anchor on.
 */
export async function explainWrongAnswer({ settings, question, options, correctIndex, userIndex, baseExplanation, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const lines = options.map((option, index) => `${letters[index] || index + 1}. ${option}`).join('\n');
  const system =
    'You are a patient CFA tutor. The student picked the wrong option on a multiple-choice question. ' +
    'Explain in 3-5 sentences why the correct option is right, then briefly why the student\'s choice is a common trap. ' +
    'Be concrete and quantitative where it helps. Do not restate the question text.';
  const user = `Question: ${question}\n\nOptions:\n${lines}\n\nCorrect answer: ${letters[correctIndex] || correctIndex + 1}\nStudent picked: ${letters[userIndex] || userIndex + 1}${baseExplanation ? `\n\nProvided explanation context:\n${baseExplanation}` : ''}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_CHAT_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. Enable CORS in LM Studio (Developer/Server panel) or start Ollama with OLLAMA_ORIGINS=* set. The Tauri shell does not need this.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The model returned an empty explanation. Try a more capable local model.');
    }
    return content.trim();
  });
}

/**
 * AI rubric critique for a CFA Level III constructed-response answer.
 * Calls the local model to assess each rubric criterion against the candidate's
 * actual response text and returns the model's prose critique directly.
 *
 * @param {object} params
 * @param {object} params.settings  - LLM settings (baseUrl, model)
 * @param {string} params.prompt    - The question / prompt shown to the candidate
 * @param {string} params.response  - The candidate's written response
 * @param {Array<{ id: string, label: string, maxPoints: number, description?: string }>} params.rubric
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} The model's free-form critique text (trimmed).
 */
export async function critiqueConstructedResponse({ settings, prompt, response, rubric, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();

  const system =
    'You are a CFA Level III rubric grader. Score the candidate\'s response against EACH rubric criterion. ' +
    'For every criterion output: a short verdict (Met / Partial / Missed), 1-2 sentences of evidence-based feedback grounded in the candidate\'s actual words, ' +
    'and 1 concrete improvement suggestion. Do NOT inflate scores — be exam-realistic.';

  const criteriaBlock = (rubric || [])
    .map((criterion) => `Criterion [${criterion.id}] "${criterion.label}" — max ${criterion.maxPoints} pt${criterion.maxPoints !== 1 ? 's' : ''}${criterion.description ? `: ${criterion.description}` : ''}`)
    .join('\n');

  const user =
    `Prompt:\n${prompt}\n\nRubric criteria:\n${criteriaBlock}\n\nCandidate response:\n${response}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let fetchResponse;
    try {
      fetchResponse = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_CHAT_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. Enable CORS in LM Studio (Developer/Server panel) or start Ollama with OLLAMA_ORIGINS=* set. The Tauri shell does not need this.`,
        { cause: error },
      );
    }
    if (!fetchResponse.ok) throw new Error(`Local model server responded ${fetchResponse.status}.`);
    const data = await fetchResponse.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The model returned an empty critique. Try a more capable local model.');
    }
    return content.trim();
  });
}

/**
 * Structured Level III rubric grade: each criterion gets a verdict, a numeric
 * score, evidence, and an improvement suggestion. Plus an overall PASS /
 * BORDERLINE / FAIL synthesis with a percentage.
 *
 * Returns { overall: { verdict, percent, total, max }, criteria: [...] }.
 * Throws on parse failure with a helpful message naming the offending JSON.
 *
 * @param {Object} params
 * @param {Object} params.settings — LLM settings (baseUrl, model, contextWindow)
 * @param {string} params.prompt
 * @param {string} params.response
 * @param {Array<{ id: string, label: string, maxPoints: number, description?: string }>} params.rubric
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{
 *   overall: { verdict: 'PASS'|'BORDERLINE'|'FAIL', percent: number, total: number, max: number, summary: string },
 *   criteria: Array<{
 *     id: string,
 *     label: string,
 *     verdict: 'Met'|'Partial'|'Missed',
 *     score: number,
 *     maxPoints: number,
 *     evidence: string,
 *     improvement: string,
 *   }>,
 * }>}
 */
export async function gradeConstructedResponseStructured({ settings, prompt, response, rubric, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const safeRubric = Array.isArray(rubric) ? rubric : [];
  if (safeRubric.length === 0) {
    throw new Error('No rubric criteria provided.');
  }

  const criteriaBlock = safeRubric
    .map((c) => `  - id: "${c.id}", label: "${c.label}", max ${c.maxPoints} pt${c.maxPoints !== 1 ? 's' : ''}${c.description ? `, guidance: ${c.description}` : ''}`)
    .join('\n');

  const system =
    'You are a CFA Level III rubric grader. Return ONLY a JSON object — no prose, no markdown fences. Shape:\n' +
    '{\n' +
    '  "criteria": [\n' +
    '    { "id": "<rubric id>", "verdict": "Met"|"Partial"|"Missed", "score": <number ≤ maxPoints>, "evidence": "<1-2 sentences grounded in the candidate text>", "improvement": "<one concrete suggestion>" }\n' +
    '  ],\n' +
    '  "summary": "<2-3 sentences on the overall response — what was strong, what was the biggest weakness>"\n' +
    '}\n' +
    'Score conservatively — Level III graders do not inflate. Met = full credit, Partial = at most 60% of maxPoints, Missed = 0.';

  const user =
    `Prompt:\n${prompt}\n\nRubric criteria:\n${criteriaBlock}\n\nCandidate response:\n${response}\n\nReturn the JSON now.`;

  const endpoint = `${base}/chat/completions`;
  const requestBody = {
    model,
    temperature: 0.15,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, requestBody);

  return dedupeRequest(signature, async () => {
  let fetchResponse;
  try {
    fetchResponse = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
      { timeoutMs: LLM_TIMEOUT_CHAT_MS, callerSignal: signal },
    );
  } catch (error) {
    if (error?.isLlmTimeout) throw error;
    if (error?.name === 'AbortError') throw error;
    throw new Error(
      `Could not reach ${base} from the browser. Enable CORS in LM Studio (Developer/Server panel) or start Ollama with OLLAMA_ORIGINS=* set. The Tauri shell does not need this.`,
      { cause: error },
    );
  }
  if (!fetchResponse.ok) throw new Error(`Local model server responded ${fetchResponse.status}.`);
  const data = await fetchResponse.json();
  const content = data?.choices?.[0]?.message?.content || '';

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('The model did not return a JSON grade. Try a more capable local model.');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Could not parse rubric grade JSON: ${err.message}`, { cause: err });
  }

  const rubricById = new Map(safeRubric.map((c) => [c.id, c]));
  const rawCriteria = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  const seen = new Set();
  const criteria = [];
  for (const entry of rawCriteria) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    if (!id) continue;
    const meta = rubricById.get(id);
    if (!meta) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const verdictRaw = typeof entry.verdict === 'string' ? entry.verdict.toLowerCase() : '';
    let verdict = 'Missed';
    if (verdictRaw.startsWith('met')) verdict = 'Met';
    else if (verdictRaw.startsWith('partial')) verdict = 'Partial';
    const proposed = Number(entry.score);
    const score = Number.isFinite(proposed)
      ? Math.max(0, Math.min(meta.maxPoints, proposed))
      : verdict === 'Met'
        ? meta.maxPoints
        : verdict === 'Partial'
          ? Math.round(meta.maxPoints * 0.6 * 10) / 10
          : 0;
    criteria.push({
      id,
      label: meta.label,
      verdict,
      score,
      maxPoints: meta.maxPoints,
      evidence: typeof entry.evidence === 'string' ? entry.evidence.trim() : '',
      improvement: typeof entry.improvement === 'string' ? entry.improvement.trim() : '',
    });
  }
  // If the model skipped any criteria, fill them in as Missed so totals stay honest.
  for (const meta of safeRubric) {
    if (seen.has(meta.id)) continue;
    criteria.push({
      id: meta.id,
      label: meta.label,
      verdict: 'Missed',
      score: 0,
      maxPoints: meta.maxPoints,
      evidence: 'Model did not cover this criterion.',
      improvement: 'Reconsider this criterion explicitly in your next attempt.',
    });
  }

  const total = criteria.reduce((acc, c) => acc + c.score, 0);
  const max = criteria.reduce((acc, c) => acc + c.maxPoints, 0);
  const percent = max > 0 ? Math.round((total / max) * 100) : 0;
  // Exam-realistic cutoffs:
  //   < 50% → FAIL, 50–69% → BORDERLINE, ≥ 70% → PASS
  let verdict = 'FAIL';
  if (percent >= 70) verdict = 'PASS';
  else if (percent >= 50) verdict = 'BORDERLINE';

  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : verdict === 'PASS'
      ? 'Solid Level-III answer overall — minor gaps remain.'
      : verdict === 'BORDERLINE'
        ? 'On the edge — the response addresses most criteria but has notable gaps.'
        : 'Substantial gaps against the rubric — revisit the underlying concept and try again.';

  return {
    overall: { verdict, percent, total, max, summary },
    criteria,
  };
  });
}

/**
 * Personalized 2-paragraph narrative for a Study Director plan.
 * Given the structured plan from buildStudyPlan, asks the local model to
 * explain WHY today's prioritization makes sense in plain language — useful
 * as a "coach's note" above the action list.
 */
export async function narrateStudyPlan({ settings, plan, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const actionLines = (plan?.actions || [])
    .slice(0, 6)
    .map((action, index) => `${index + 1}. [${action.kind}] ${action.title} — ${action.reason}`)
    .join('\n');
  const system =
    'You are a patient CFA study coach. The student has a prioritized action list from a spaced-repetition + readiness model. ' +
    'Write a short 2-paragraph "why this plan today" rationale (max ~110 words total). ' +
    'Paragraph 1: the single most important thing to start with and why, anchored to the listed action. ' +
    'Paragraph 2: what success looks like at end of session + the 1-2 traps to avoid. ' +
    'Be concrete, encouraging, exam-focused. Do not restate the plan as bullets; give prose.';
  const user = `Headline: ${plan?.headline || ''}\nDue reviews: ${plan?.dueCount ?? 0}\nWeak topics: ${plan?.weakCount ?? 0}\n${plan?.peakReviewDay ? `Upcoming peak: ${plan.peakReviewDay.date} (${plan.peakReviewDay.count} items)\n` : ''}\nAction list:\n${actionLines}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_CHAT_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. Enable CORS in LM Studio (Developer/Server panel) or start Ollama with OLLAMA_ORIGINS=* set. The Tauri shell does not need this.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The model returned an empty narrative. Try a more capable local model.');
    }
    return content.trim();
  });
}

/**
 * Quick AI-generated summary of a topic's curriculum chunks. 3-4 paragraphs:
 * the core idea, the key formulas/distinctions, the common exam traps.
 */
export async function summarizeTopicFromCurriculum({ settings, topicTitle, chunks, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const packed = packCurriculumChunks(settings, chunks);
  const context = packed.text;
  if (!context) throw new Error('No curriculum text available to summarize.');

  const system =
    'You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write a focused 3-4 paragraph review summary of the topic for an exam-prep student. ' +
    'Paragraph 1: the core idea + why it matters on the exam. ' +
    'Paragraph 2: the key formulas, definitions, or distinctions the student MUST memorize. ' +
    'Paragraph 3: 2-3 common exam traps + how to avoid them. ' +
    'Paragraph 4 (optional): one mnemonic or quick mental model. ' +
    'Output plain prose, no bullets, no headings.';
  const user = `Topic: ${topicTitle}\n\nExcerpts:\n\n${context}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.25,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_CHAT_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. Enable CORS in LM Studio (Developer/Server panel) or start Ollama with OLLAMA_ORIGINS=* set. The Tauri shell does not need this.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The model returned an empty summary. Try a more capable local model.');
    }
    return content.trim();
  });
}

export async function getCachedGeneratedQuestions(level, topic) {
  try {
    const row = await getStorage().settings.get(`ai-questions:${level}:${topic}`);
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function saveCachedGeneratedQuestions(level, topic, questions) {
  const payload = { questions, generatedAt: new Date().toISOString() };
  await getStorage().settings.put({ key: `ai-questions:${level}:${topic}`, value: payload, updatedAt: payload.generatedAt });
  return payload;
}

export async function getCachedGeneratedFlashcards(level, topic) {
  try {
    const row = await getStorage().settings.get(`flash-cards:${level}:${topic}`);
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function saveCachedGeneratedFlashcards(level, topic, flashcards) {
  const payload = { flashcards, generatedAt: new Date().toISOString() };
  await getStorage().settings.put({ key: `flash-cards:${level}:${topic}`, value: payload, updatedAt: payload.generatedAt });
  return payload;
}

export async function getCachedTopicSummary(level, topic) {
  try {
    const row = await getStorage().settings.get(`topic-summary:${level}:${topic}`);
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function saveCachedTopicSummary(level, topic, summary) {
  const payload = { summary, generatedAt: new Date().toISOString() };
  await getStorage().settings.put({ key: `topic-summary:${level}:${topic}`, value: payload, updatedAt: payload.generatedAt });
  return payload;
}

/**
 * AI flashcard generator from curriculum excerpts.
 * Uses the local model to produce `{ front, back, locator? }` card objects
 * grounded strictly in the provided curriculum chunks.
 *
 * @param {object} params
 * @param {object} params.settings    - LLM settings (baseUrl, model, enabled)
 * @param {string} params.topicTitle  - Human-readable topic label
 * @param {Array<{ locator?: string, text: string }>} params.chunks
 * @param {number} [params.count=6]   - How many cards to request
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array<{ id: string, front: string, back: string, locator?: string }>>}
 */
export async function generateFlashcardsFromCurriculum({ settings, topicTitle, chunks, count = 6, signal }) {
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();
  const packed = packCurriculumChunks(settings, chunks);
  const context = packed.text;
  if (!context) throw new Error('No curriculum text available to ground generation.');

  const system =
    'You are a CFA tutor. Using ONLY the provided curriculum excerpts, write concise flashcards. ' +
    'Front = a focused prompt (definition / formula / scenario). ' +
    'Back = a precise 1-3 sentence answer + a citation locator if obvious from the excerpts. ' +
    'Respond with a JSON array — no prose.';
  const user = `Topic: ${topicTitle}\n\nWrite ${count} flashcards grounded strictly in these excerpts:\n\n${context}`;

  const endpoint = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_GENERATION_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. If you are using LM Studio, open its Developer / Server panel and enable CORS for "*" (then restart the server). For Ollama, start it with OLLAMA_ORIGINS=* set. The desktop (Tauri) shell does not need this — it calls the model natively.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonArray(content);
    if (!parsed) throw new Error('The model did not return parseable flashcards. Try a more capable local model.');

    return parsed
      .filter((item) => item && typeof item.front === 'string' && item.front.trim() && typeof item.back === 'string' && item.back.trim())
      .slice(0, count)
      .map((item, index) => ({
        id: `flash-${index + 1}`,
        front: item.front.trim(),
        back: item.back.trim(),
        ...(typeof item.locator === 'string' && item.locator.trim() ? { locator: item.locator.trim() } : {}),
      }));
  });
}

/**
 * Low-level OpenAI-style chat-completion call against the configured local
 * LLM. Used by callers that need raw text (podcast script generation,
 * future generic-prompt features). Returns `{ text }`.
 *
 * @param {Object} params
 * @param {string} params.prompt           - User-facing prompt
 * @param {string} [params.system]         - Optional system prompt
 * @param {number} [params.temperature=0.4]
 * @param {number} [params.maxTokens]      - Optional max_tokens hint to the model
 * @param {Object} [params.settings]       - Override settings; default = saved settings
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text: string }>}
 */
export async function generateText({
  prompt,
  system,
  temperature = 0.4,
  maxTokens,
  settings: overrideSettings,
  signal,
}) {
  const settings = overrideSettings ?? (await getLlmSettings());
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: String(prompt ?? '') });

  const body = {
    model,
    temperature,
    messages,
  };
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
    body.max_tokens = maxTokens;
  }

  const endpoint = `${base}/chat/completions`;
  const signature = requestSignature(endpoint, body);

  return dedupeRequest(signature, async () => {
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs: LLM_TIMEOUT_GENERATION_MS, callerSignal: signal },
      );
    } catch (error) {
      if (error?.isLlmTimeout) throw error;
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        `Could not reach ${base} from the browser. If you are using LM Studio, open its Developer / Server panel and enable CORS for "*" (then restart the server). For Ollama, start it with OLLAMA_ORIGINS=* set.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return { text: String(content) };
  });
}

/**
 * Streaming counterpart to {@link generateText} (BB2).
 *
 * The host historically had NO streaming — every helper above awaits the full
 * completion, so a long generation looks frozen. This gives the CFA/host side
 * real token-by-token streaming over the SAME OpenAI-compatible endpoint by
 * setting `stream:true` and consuming the response through the unified
 * {@link streamSse} client. Tokens arrive via `onToken`; `onDone` fires once
 * with the full accumulated text; a stalled model surfaces a DISTINCT `onTimeout`
 * (carrying an `isLlmTimeout` error) instead of a generic CORS-looking failure;
 * `onError` carries the wrapped CORS/connection/status error, mapped to the
 * SAME actionable strings the non-streaming path already produces so existing
 * error-matching (CORS / OLLAMA_ORIGINS / "responded N") is preserved.
 *
 * Backward-compatible & additive: this is a NEW export — `generateText` and
 * every other helper keep their exact signatures and behaviour. Callers that
 * want streaming opt in; everyone else is untouched.
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {string} [params.system]
 * @param {number} [params.temperature=0.4]
 * @param {number} [params.maxTokens]
 * @param {Object} [params.settings]            - Override settings; default = saved settings
 * @param {AbortSignal} [params.signal]         - Caller cancellation
 * @param {(token: string) => void} [params.onToken]
 * @param {(fullText: string) => void} [params.onDone]
 * @param {(error: Error) => void} [params.onTimeout] - Distinct stall/timeout path
 * @param {(error: Error) => void} [params.onError]
 * @returns {Promise<{ text: string }>} Resolves with the full accumulated text
 *   when the stream completes cleanly; rejects on a definitive error or timeout
 *   (so awaiting callers that did NOT pass handlers still see failures).
 */
export async function streamText({
  prompt,
  system,
  temperature = 0.4,
  maxTokens,
  settings: overrideSettings,
  signal,
  onToken,
  onDone,
  onTimeout,
  onError,
}) {
  const settings = overrideSettings ?? (await getLlmSettings());
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: String(prompt ?? '') });

  const body = {
    model,
    temperature,
    stream: true,
    messages,
  };
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
    body.max_tokens = maxTokens;
  }

  const endpoint = `${base}/chat/completions`;

  let text = '';
  // The CORS-actionable wrapper the non-streaming path uses, so callers matching
  // on /CORS|OLLAMA_ORIGINS/ keep working when the stream cannot even connect.
  const wrapConnectError = (cause) =>
    new Error(
      `Could not reach ${base} from the browser. If you are using LM Studio, open its Developer / Server panel and enable CORS for "*" (then restart the server). For Ollama, start it with OLLAMA_ORIGINS=* set.`,
      { cause },
    );

  return new Promise((resolve, reject) => {
    void streamSse(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      {
        onDelta: (token) => {
          text += token;
          onToken?.(token);
        },
        onDone: () => {
          onDone?.(text);
          resolve({ text });
        },
        onTimeout: (error) => {
          onTimeout?.(error);
          reject(error);
        },
        onError: (error) => {
          // A non-OK status carries `.status`; mirror the non-streaming message.
          const wrapped =
            typeof error?.status === 'number'
              ? new Error(`Local model server responded ${error.status}.`, { cause: error })
              // Genuine connection failures (TypeError) → the CORS-actionable hint.
              : isStreamTimeout(error)
                ? error
                : wrapConnectError(error);
          onError?.(wrapped);
          reject(wrapped);
        },
      },
      {
        // Reuse the chat-tier deadline as a total budget, plus the unified
        // client's default stall watchdog so a wedged model trips `onTimeout`.
        totalTimeoutMs: LLM_TIMEOUT_GENERATION_MS,
        signal,
      },
    ).then(
      () => {
        // streamSse resolves after the terminal handler ran. If the stream ended
        // with neither done nor error (e.g. a caller abort), settle so awaiting
        // callers are never left hanging.
        resolve({ text });
      },
      // streamSse never rejects, but guard defensively.
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
