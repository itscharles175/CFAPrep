import { getStorage } from './storage';
import { generateQuestionsFromCurriculum } from './localLlm';
import { getCfaSourceReadingForTopic } from './cfaSourceVault';

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
        generated.forEach((question, index) => {
          questions.push({
            ...question,
            id: `gen-${topic.topic}-${index + 1}`,
            topic: topic.topic,
            topicTitle: topic.title,
          });
        });
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
