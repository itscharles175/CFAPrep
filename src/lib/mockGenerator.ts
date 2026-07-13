import { getStorage } from './storage';
import { generateQuestionsFromCurriculum } from './localLlm';
import { getCfaSourceReadingForTopic } from './cfaSourceVault';
import { fetchLsatSidecar } from './lsatSidecarClient';

// INT-1 — shared generation-quality gate. The LSAT FastAPI sidecar (:8100)
// exposes POST /api/gen/generation-quality wrapping the same validate_candidate
// rubric the LSAT generation pipeline uses (trap-metadata, distractor-quality,
// single-defensible, self-consistency, …). Routing host CFA mock content through
// it means generated/imported questions are gated against ONE quality bar across
// domains. Kept inside this module (a NEW seam this item owns) so DATA-1's
// lsatBackend.ts is untouched; the degrading-fetch shape mirrors that client.
const LSAT_GEN_QUALITY_PATH = '/api/gen/generation-quality';

const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

/** One per-gate verdict from the backend ValidationReport. */
interface GenQualityGate {
  gate: string;
  passed: boolean | null;
  reason: string | null;
}

/** The typed ValidationReport the generation-quality endpoint returns. */
interface GenQualityReport {
  passed: boolean;
  reason: string | null;
  gate_confidence: number;
  score: number;
  failure_reasons: string[];
  gates: GenQualityGate[];
  checks: Record<string, unknown>;
  error: string | null;
}

/** Outcome of gating one generated question. */
export interface QuestionGateResult {
  /** True when the question should be kept in the mock. */
  keep: boolean;
  /** True when the sidecar answered (verdict trusted); false when we degraded. */
  reachable: boolean;
  /** The failure reason that caused a reject (when keep === false). */
  reason?: string;
  /** The raw report when the sidecar answered (for diagnostics/telemetry). */
  report?: GenQualityReport;
}

// Reasons that mean the CFA content itself is unsound (weak distractors, an
// ambiguous/mis-keyed answer). The host MUST fail-closed on these. A bare
// "structural" failure is excluded: CFA items legitimately carry 3 options, not
// the LSAT 5-choice A-E envelope, so an envelope-shape mismatch is not a
// content-quality signal and must not drop otherwise-good questions.
const CONTENT_QUALITY_FAILURES = new Set([
  'weak_distractors',
  'distractor_quality_unverified',
  'ambiguous_answer',
  'solve_mismatch',
  'cove_disagreement',
  'lexical_leak',
]);

interface RawGeneratedQuestion {
  question?: unknown;
  options?: unknown;
  correct?: unknown;
  explanation?: unknown;
  [key: string]: unknown;
}

/**
 * Map a host CFA question ({ question, options[], correct }) into the LSAT
 * candidate envelope the gate consumes. Distractors get a generic non-"none"
 * trap_type and the credited choice "none" so the deterministic trap-metadata
 * check is satisfied; the substantive signal comes from the distractor-quality
 * and single-defensible critic gates. Returns null when the shape is unusable.
 */
function toCandidate(raw: RawGeneratedQuestion): Record<string, unknown> | null {
  const stem = typeof raw.question === 'string' ? raw.question.trim() : '';
  const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : [];
  if (!stem || options.length < 2) return null;
  const correctIdx =
    Number.isInteger(raw.correct) && (raw.correct as number) >= 0 && (raw.correct as number) < options.length
      ? (raw.correct as number)
      : 0;
  const choices = options.slice(0, CHOICE_LABELS.length).map((text, i) => ({
    label: CHOICE_LABELS[i],
    text,
    trap_type: i === correctIdx ? 'none' : 'out_of_scope',
  }));
  return {
    stem,
    prompt: 'Which of the following is most accurate?',
    correct_answer: CHOICE_LABELS[correctIdx] ?? 'A',
    choices,
  };
}

/**
 * Gate one generated CFA question against the shared LSAT rubric. Never throws.
 *
 * Fail-closed on content quality: when the sidecar answers and the verdict cites
 * a content-quality failure (weak distractors, ambiguous/mis-keyed answer), the
 * question is dropped. Degrade gracefully otherwise: an unreachable sidecar (or
 * an unmappable shape) keeps the question so a local-only user without the LSAT
 * backend running still gets a mock — the gate hardens content, it doesn't gate
 * the whole feature behind an optional sidecar.
 */
export async function gateGeneratedQuestion(
  raw: RawGeneratedQuestion,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<QuestionGateResult> {
  const candidate = toCandidate(raw);
  // Unmappable shape — let the existing runner-side filters handle it rather
  // than dropping it here on a transport concern.
  if (!candidate) return { keep: true, reachable: false };

  try {
    const res = await fetchLsatSidecar(LSAT_GEN_QUALITY_PATH, {
      method: 'POST',
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 8000,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // Disable the LSAT-specific model-heavy gates (permutation/informativity):
      // CFA items aren't LSAT 5-choice A-E, so those probes would false-fire. The
      // distractor-quality + single-defensible critic gates carry the signal.
      body: JSON.stringify({
        candidate,
        permutation_invariant: false,
        informativity: false,
      }),
    });
    if (!res.ok) return { keep: true, reachable: false };
    const report = (await res.json()) as GenQualityReport;
    // The gate couldn't actually run (model down) — degrade gracefully.
    if (report.error) return { keep: true, reachable: false, report };
    const reasons = new Set([report.reason, ...(report.failure_reasons || [])].filter(Boolean) as string[]);
    const contentFailure = [...reasons].find((r) => CONTENT_QUALITY_FAILURES.has(r));
    if (contentFailure) return { keep: false, reachable: true, reason: contentFailure, report };
    return { keep: true, reachable: true, report };
  } catch {
    // Sidecar offline / timeout / aborted: degrade gracefully (keep content).
    return { keep: true, reachable: false };
  }
}

// Generative mock exams. Assembles a fresh, full-length practice exam from the
// user's *own ingested curriculum* using their local model (Ollama / LM Studio)
// — fully offline. Each topic's questions are grounded strictly in that topic's
// curriculum chunks, then shaped into the same { levelContent, mock, items }
// structure the existing exam runner already understands, so scoring, timing,
// persistence, and recordMockAttempt all work unchanged.
//
// P7: converted from .js to TypeScript. `generateQuestionsFromCurriculum` is
// still untyped (localLlm.js), so generated questions are widened to a loose
// shape with the few fields this module relies on.

interface MockBlueprint {
  perTopic: number;
  maxTopics: number;
  title: string;
}

export const MOCK_BLUEPRINTS: Record<string, MockBlueprint> = {
  level1: { perTopic: 3, maxTopics: 10, title: 'Generated Level I Mock' },
  level2: { perTopic: 3, maxTopics: 8, title: 'Generated Level II Mock' },
  level3: { perTopic: 3, maxTopics: 6, title: 'Generated Level III Mock' },
};

export interface MockTopic {
  topic: string;
  title: string;
}

/** A model-generated question, tagged with its topic. The `[key: string]`
 *  index carries the rest of the LLM-produced shape (stem, choices, answer…)
 *  that the runner consumes unchanged. */
export interface GeneratedQuestion {
  id: string;
  topic: string;
  topicTitle: string;
  [key: string]: unknown;
}

export interface GeneratedMock {
  level: string;
  title: string;
  generatedAt: string;
  questions: GeneratedQuestion[];
}

interface GenerateMockArgs {
  level: string;
  topics: MockTopic[];
  /** local-LLM settings (from getLlmSettings) */
  settings: unknown;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; topicTitle: string }) => void;
}

/** Generate a curriculum-grounded mock for a level. */
export async function generateMockExam({
  level,
  topics,
  settings,
  signal,
  onProgress,
}: GenerateMockArgs): Promise<GeneratedMock> {
  const blueprint = MOCK_BLUEPRINTS[level] || MOCK_BLUEPRINTS.level1;
  const usable = (topics || []).filter((topic) => topic && topic.topic).slice(0, blueprint.maxTopics);
  const questions: GeneratedQuestion[] = [];
  let done = 0;

  for (const topic of usable) {
    if (signal?.aborted) throw new DOMException('Mock generation aborted', 'AbortError');
    onProgress?.({ done, total: usable.length, topicTitle: topic.title });

    const { chunks } = await getCfaSourceReadingForTopic(level, topic.topic);
    if (chunks && chunks.length) {
      try {
        // The raw model questions carry no topic tag; we add topic/topicTitle
        // (and a stable id) here, which is what makes each a GeneratedQuestion.
        // generateQuestionsFromCurriculum is now wrapped in the BB3 dedup
        // helper (untyped .js), so annotate the raw rows explicitly — they gain
        // topic/topicTitle below, which is what makes each a GeneratedQuestion.
        const generated: Array<Record<string, unknown>> = await generateQuestionsFromCurriculum({
          settings,
          topicTitle: topic.title,
          chunks: chunks.slice(0, 14),
          count: blueprint.perTopic,
          signal,
        });
        // INT-1 — gate each generated question against the shared LSAT rubric
        // before it enters the mock. Fail-closed on weak/ambiguous distractors;
        // degrade gracefully (keep) when the LSAT sidecar is offline. The index
        // is preserved off the ORIGINAL position so ids stay stable/contiguous
        // per the generation order even when a weak question is dropped.
        let kept = 0;
        for (const question of generated) {
          if (signal?.aborted) throw new DOMException('Mock generation aborted', 'AbortError');
          const gate = await gateGeneratedQuestion(question, { signal });
          if (!gate.keep) continue;
          kept += 1;
          questions.push({
            ...question,
            id: `gen-${topic.topic}-${kept}`,
            topic: topic.topic,
            topicTitle: topic.title,
          });
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
        // Surface connection/server failures (CORS, server down, HTTP status)
        // — they affect every topic, so silently skipping all would hide an
        // actionable problem. Only swallow content-level errors (model
        // returned unparseable output for one topic) and keep building.
        const message = (error as { message?: string } | null)?.message || '';
        if (/Could not reach|responded \d{3}|server responded/.test(message)) throw error;
        // otherwise: skip this topic and continue
      }
    }

    done += 1;
    onProgress?.({ done, total: usable.length, topicTitle: topic.title });
  }

  if (!questions.length) {
    throw new Error(
      'No curriculum-grounded questions could be generated. Ingest curriculum for these topics and enable a local model in System Health → Local AI first.',
    );
  }

  return { level, title: blueprint.title, generatedAt: new Date().toISOString(), questions };
}

interface SyntheticTopic {
  topic: string;
  title: string;
  questions: GeneratedQuestion[];
  vignettes: unknown[];
  learningObjectives: unknown[];
}

export interface SyntheticMockContent {
  levelContent: { topics: SyntheticTopic[]; constructedResponses: unknown[] };
  mock: {
    title: string;
    questionIds: string[];
    vignetteIds: string[];
    constructedResponseIds: string[];
  };
  items: Array<{ type: 'question'; question: GeneratedQuestion }>;
}

/**
 * Shape a generated mock into the { levelContent, mock, items } the runner uses.
 * Returns null when there's nothing to render.
 */
export function toSyntheticMockContent(generated: GeneratedMock | null | undefined): SyntheticMockContent | null {
  if (!generated || !Array.isArray(generated.questions) || generated.questions.length === 0) return null;

  const byTopic = new Map<string, SyntheticTopic>();
  for (const question of generated.questions) {
    let entry = byTopic.get(question.topic);
    if (!entry) {
      entry = {
        topic: question.topic,
        title: question.topicTitle || question.topic,
        questions: [],
        vignettes: [],
        learningObjectives: [],
      };
      byTopic.set(question.topic, entry);
    }
    entry.questions.push(question);
  }

  const levelContent = { topics: [...byTopic.values()], constructedResponses: [] };
  const mock = {
    title: generated.title,
    questionIds: generated.questions.map((question) => question.id),
    vignetteIds: [],
    constructedResponseIds: [],
  };
  // Build items directly so we never truncate (buildMockItems applies
  // level-specific slicing meant for the hand-authored blueprints).
  const items = generated.questions.map((question) => ({ type: 'question' as const, question }));
  return { levelContent, mock, items };
}

export async function getCachedGeneratedMock(level: string): Promise<GeneratedMock | null> {
  try {
    const row = await getStorage().settings.get(`generated-mock:${level}`);
    return (row?.value as GeneratedMock | undefined) || null;
  } catch {
    return null;
  }
}

export async function saveCachedGeneratedMock(level: string, generated: GeneratedMock): Promise<GeneratedMock> {
  await getStorage().settings.put({
    key: `generated-mock:${level}`,
    value: generated,
    updatedAt: new Date().toISOString(),
  });
  return generated;
}
