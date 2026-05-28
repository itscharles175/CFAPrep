import { getStorage } from './storage';
import { generateQuestionsFromCurriculum } from './localLlm';
import { getCfaSourceReadingForTopic } from './cfaSourceVault';

// Generative mock exams. Assembles a fresh, full-length practice exam from the
// user's *own ingested curriculum* using their local model (Ollama / LM Studio)
// — fully offline. Each topic's questions are grounded strictly in that topic's
// curriculum chunks, then shaped into the same { levelContent, mock, items }
// structure the existing exam runner already understands, so scoring, timing,
// persistence, and recordMockAttempt all work unchanged.

export const MOCK_BLUEPRINTS = {
  level1: { perTopic: 3, maxTopics: 10, title: 'Generated Level I Mock' },
  level2: { perTopic: 3, maxTopics: 8, title: 'Generated Level II Mock' },
  level3: { perTopic: 3, maxTopics: 6, title: 'Generated Level III Mock' },
};

/**
 * Generate a curriculum-grounded mock for a level.
 * @param {object} args
 * @param {string} args.level
 * @param {Array<{topic: string, title: string}>} args.topics  topic list from level content
 * @param {object} args.settings  local-LLM settings (from getLlmSettings)
 * @param {AbortSignal} [args.signal]
 * @param {(p: {done:number,total:number,topicTitle:string}) => void} [args.onProgress]
 */
export async function generateMockExam({ level, topics, settings, signal, onProgress }) {
  const blueprint = MOCK_BLUEPRINTS[level] || MOCK_BLUEPRINTS.level1;
  const usable = (topics || []).filter((topic) => topic && topic.topic).slice(0, blueprint.maxTopics);
  const questions = [];
  let done = 0;

  for (const topic of usable) {
    if (signal?.aborted) throw new DOMException('Mock generation aborted', 'AbortError');
    onProgress?.({ done, total: usable.length, topicTitle: topic.title });

    const { chunks } = await getCfaSourceReadingForTopic(level, topic.topic);
    if (chunks && chunks.length) {
      try {
        const generated = await generateQuestionsFromCurriculum({
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
        if (error?.name === 'AbortError') throw error;
        // Surface connection/server failures (CORS, server down, HTTP status)
        // — they affect every topic, so silently skipping all would hide an
        // actionable problem. Only swallow content-level errors (model
        // returned unparseable output for one topic) and keep building.
        const message = error?.message || '';
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

/**
 * Shape a generated mock into the { levelContent, mock, items } the runner uses.
 * Returns null when there's nothing to render.
 */
export function toSyntheticMockContent(generated) {
  if (!generated || !Array.isArray(generated.questions) || generated.questions.length === 0) return null;

  const byTopic = new Map();
  for (const question of generated.questions) {
    if (!byTopic.has(question.topic)) {
      byTopic.set(question.topic, {
        topic: question.topic,
        title: question.topicTitle || question.topic,
        questions: [],
        vignettes: [],
        learningObjectives: [],
      });
    }
    byTopic.get(question.topic).questions.push(question);
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
  const items = generated.questions.map((question) => ({ type: 'question', question }));
  return { levelContent, mock, items };
}

export async function getCachedGeneratedMock(level) {
  try {
    const row = await getStorage().settings.get(`generated-mock:${level}`);
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function saveCachedGeneratedMock(level, generated) {
  await getStorage().settings.put({ key: `generated-mock:${level}`, value: generated, updatedAt: new Date().toISOString() });
  return generated;
}
