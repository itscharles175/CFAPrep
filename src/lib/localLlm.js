import { db } from './progressStore';

// Local-LLM integration. Targets an OpenAI-compatible chat endpoint exposed by a
// local model server (Ollama at :11434/v1, LM Studio at :1234/v1). No cloud, no
// API key — the app stays fully offline; this feature only lights up when the
// user's local server is running and configured.

const SETTINGS_KEY = 'local-llm';

export const DEFAULT_LLM_SETTINGS = {
  enabled: false,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1',
};

export const LLM_PRESETS = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
];

export async function getLlmSettings() {
  try {
    const row = await db.settings.get(SETTINGS_KEY);
    return { ...DEFAULT_LLM_SETTINGS, ...(row?.value || {}) };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export async function saveLlmSettings(settings) {
  const merged = { ...DEFAULT_LLM_SETTINGS, ...settings };
  await db.settings.put({ key: SETTINGS_KEY, value: merged, updatedAt: new Date().toISOString() });
  return merged;
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_LLM_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
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
  const context = (chunks || [])
    .map((chunk) => `[${chunk.locator || 'excerpt'}] ${chunk.text}`)
    .join('\n\n')
    .slice(0, 12000);
  if (!context) throw new Error('No curriculum text available to ground generation.');

  const system =
    'You are a CFA exam tutor. Using ONLY the provided curriculum excerpts, write exam-style practice multiple-choice questions. ' +
    'Respond with a JSON array and nothing else. Each element must be an object: ' +
    '{"question": string, "options": [string, string, string], "correct": integer (0-based index of the correct option), "explanation": string}.';
  const user = `Topic: ${topicTitle}\n\nWrite ${count} questions grounded strictly in these excerpts:\n\n${context}`;

  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    });
  } catch (error) {
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

  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    });
  } catch (error) {
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

  let fetchResponse;
  try {
    fetchResponse = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    });
  } catch (error) {
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
}

export async function getCachedGeneratedQuestions(level, topic) {
  try {
    const row = await db.settings.get(`ai-questions:${level}:${topic}`);
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function saveCachedGeneratedQuestions(level, topic, questions) {
  const payload = { questions, generatedAt: new Date().toISOString() };
  await db.settings.put({ key: `ai-questions:${level}:${topic}`, value: payload, updatedAt: payload.generatedAt });
  return payload;
}
