/**
 * Targeted Material Queue
 *
 * Orchestrator that turns a list of weak topics into a queue of AI-generation
 * jobs (questions / flashcards / topic summaries) — all backed by the local
 * model, all grounded in the user's ingested curriculum.  The queue is
 * persisted to storage so a user can come back later and resume.
 *
 * Storage key: `targeted-material:queue`
 *
 * Layer 1 (pure-ish): `generateTargetedMaterialJobs`
 *   Reads existing AI-content cache slots, the storage queue, and the supplied
 *   weak-topic list. Emits a deterministic set of pending jobs.
 *
 * Layer 2 (side-effecty): `runTargetedMaterialJob`
 *   Routes to the localLlm.js generators and persists results into the
 *   existing AI-content cache slots so the rest of the app picks them up
 *   automatically.
 */

import {
  generateFlashcardsFromCurriculum,
  generateQuestionsFromCurriculum,
  getCachedGeneratedFlashcards,
  getCachedGeneratedQuestions,
  getCachedTopicSummary,
  getLlmSettings,
  saveCachedGeneratedFlashcards,
  saveCachedGeneratedQuestions,
  saveCachedTopicSummary,
  summarizeTopicFromCurriculum,
} from './localLlm';
import { getStorage } from './storage';

export const TARGETED_QUEUE_KEY = 'targeted-material:queue';
export const DEFAULT_THRESHOLD = 0.55;
export const DEFAULT_PER_TOPIC_LIMIT = 2;
export const FRESH_ARTIFACT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type TargetedMaterialDomain = 'cfa' | 'excel' | 'quant';
export type TargetedMaterialKind = 'questions' | 'flashcards' | 'summary';
export type TargetedMaterialStatus = 'pending' | 'running' | 'done' | 'error';

export interface TargetedMaterialJob {
  id: string;
  domain: TargetedMaterialDomain;
  level: string;
  topic: string;
  title: string;
  kind: TargetedMaterialKind;
  status: TargetedMaterialStatus;
  reason: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface WeakTopicInput {
  domain: TargetedMaterialDomain;
  level: string;
  topic: string;
  title: string;
  mastery: number;
}

// Stable order so dedupe + UI listing are deterministic.
const KIND_ORDER: readonly TargetedMaterialKind[] = ['questions', 'flashcards', 'summary'];

// --------------------------------------------------------------------------
// Queue persistence helpers (exported for tests + UI)
// --------------------------------------------------------------------------

export async function readQueue(): Promise<TargetedMaterialJob[]> {
  try {
    const row = await getStorage().settings.get(TARGETED_QUEUE_KEY);
    const value = row?.value;
    if (!Array.isArray(value)) return [];
    return value as TargetedMaterialJob[];
  } catch {
    return [];
  }
}

export async function writeQueue(jobs: TargetedMaterialJob[]): Promise<void> {
  await getStorage().settings.put({
    key: TARGETED_QUEUE_KEY,
    value: jobs,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearQueue(): Promise<void> {
  try {
    await getStorage().settings.delete(TARGETED_QUEUE_KEY);
  } catch {
    /* swallow */
  }
}

/**
 * Return jobs left in `running` by an app quit or process interruption to a
 * retryable state. Completed work and explicit failures are left untouched.
 * Call this once when the local generation worker starts.
 */
export async function recoverInterruptedTargetedMaterialJobs(): Promise<TargetedMaterialJob[]> {
  const jobs = await readQueue();
  let changed = false;
  const recovered = jobs.map((job) => {
    if (job.status !== 'running') return job;
    changed = true;
    return {
      ...job,
      status: 'pending' as const,
      completedAt: undefined,
      error: undefined,
    };
  });
  if (changed) await writeQueue(recovered);
  return recovered;
}

// --------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// --------------------------------------------------------------------------

export function jobIdFor(
  domain: TargetedMaterialDomain,
  level: string,
  topic: string,
  kind: TargetedMaterialKind,
): string {
  return `targeted:${domain}:${level}:${topic}:${kind}`;
}

function isFreshArtifact(generatedAt: string | undefined, now: number): boolean {
  if (!generatedAt) return false;
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed < FRESH_ARTIFACT_WINDOW_MS;
}

interface CachedArtifactRecord {
  generatedAt?: string;
}

async function recentArtifactExists(
  domain: TargetedMaterialDomain,
  level: string,
  topic: string,
  kind: TargetedMaterialKind,
  now: number,
): Promise<boolean> {
  // We only have caches for CFA-style content today. For other domains the
  // cache lookup will simply be a no-op and we always allow the job.
  if (domain !== 'cfa') return false;
  try {
    if (kind === 'questions') {
      const cached = (await getCachedGeneratedQuestions(level, topic)) as CachedArtifactRecord | null;
      return isFreshArtifact(cached?.generatedAt, now);
    }
    if (kind === 'flashcards') {
      const cached = (await getCachedGeneratedFlashcards(level, topic)) as CachedArtifactRecord | null;
      return isFreshArtifact(cached?.generatedAt, now);
    }
    if (kind === 'summary') {
      const cached = (await getCachedTopicSummary(level, topic)) as CachedArtifactRecord | null;
      return isFreshArtifact(cached?.generatedAt, now);
    }
  } catch {
    return false;
  }
  return false;
}

// --------------------------------------------------------------------------
// Layer 1: generate jobs from weak topics
// --------------------------------------------------------------------------

export async function generateTargetedMaterialJobs(opts: {
  weakTopics: WeakTopicInput[];
  threshold?: number;
  perTopicLimit?: number;
  /** Optional clock for deterministic tests. */
  now?: Date;
}): Promise<TargetedMaterialJob[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const perTopicLimit = Math.max(0, opts.perTopicLimit ?? DEFAULT_PER_TOPIC_LIMIT);
  const now = (opts.now ?? new Date()).getTime();
  const nowIso = new Date(now).toISOString();

  const existing = await readQueue();
  const existingById = new Map(existing.map((job) => [job.id, job]));
  const merged: TargetedMaterialJob[] = [...existing];

  const eligible = (opts.weakTopics || []).filter((t) => t.mastery < threshold);

  for (const weak of eligible) {
    // Count any pre-existing non-error jobs for this topic against the cap so
    // the function is idempotent (re-running with the same inputs is a no-op).
    let slotsUsed = KIND_ORDER.reduce((count, kind) => {
      const prior = existingById.get(jobIdFor(weak.domain, weak.level, weak.topic, kind));
      return count + (prior && prior.status !== 'error' ? 1 : 0);
    }, 0);
    for (const kind of KIND_ORDER) {
      if (slotsUsed >= perTopicLimit) break;
      const id = jobIdFor(weak.domain, weak.level, weak.topic, kind);

      // If a non-error entry already exists for this id, don't recreate it —
      // we only resurrect entries that previously errored.
      const prior = existingById.get(id);
      if (prior && prior.status !== 'error') continue;

      // If a recent (<= 7d) cached artifact exists, suppress the job.
      const fresh = await recentArtifactExists(
        weak.domain,
        weak.level,
        weak.topic,
        kind,
        now,
      );
      if (fresh) continue;

      const reason = `Topic ${weak.title} mastery is ${Math.round(weak.mastery * 100)}% — below ${Math.round(threshold * 100)}% threshold.`;
      const job: TargetedMaterialJob = {
        id,
        domain: weak.domain,
        level: weak.level,
        topic: weak.topic,
        title: weak.title,
        kind,
        status: 'pending',
        reason,
        createdAt: nowIso,
      };

      if (prior) {
        // Replace the prior errored entry in-place.
        const idx = merged.findIndex((j) => j.id === id);
        if (idx >= 0) merged[idx] = job;
        else merged.push(job);
      } else {
        merged.push(job);
      }
      existingById.set(id, job);
      slotsUsed += 1;
    }
  }

  await writeQueue(merged);
  return merged;
}

// --------------------------------------------------------------------------
// Layer 2: run a single job
// --------------------------------------------------------------------------

interface CurriculumChunk {
  locator?: string;
  text: string;
}

async function loadCurriculumChunksFor(
  job: TargetedMaterialJob,
): Promise<CurriculumChunk[]> {
  if (job.domain !== 'cfa') return [];
  try {
    const { getCfaSourceReadingForTopic } = await import('./cfaSourceVault');
    const result = await getCfaSourceReadingForTopic(job.level, job.topic);
    return (result.chunks || []).slice(0, 14).map((chunk) => ({
      locator: chunk.locator,
      text: chunk.text,
    }));
  } catch {
    return [];
  }
}

export async function runTargetedMaterialJob(
  job: TargetedMaterialJob,
  options: { signal?: AbortSignal } = {},
): Promise<TargetedMaterialJob> {
  const queue = await readQueue();
  const idx = queue.findIndex((j) => j.id === job.id);

  // Mark running.
  const running: TargetedMaterialJob = { ...job, status: 'running', error: undefined };
  if (idx >= 0) queue[idx] = running;
  else queue.push(running);
  await writeQueue(queue);

  let updated: TargetedMaterialJob = running;
  try {
    const settings = await getLlmSettings();
    if (!settings?.enabled) {
      throw new Error('Local model is not enabled. Configure it in System Health → Local AI.');
    }

    const chunks = await loadCurriculumChunksFor(running);
    if (!chunks.length) {
      throw new Error(`No ingested curriculum chunks available for ${running.title}.`);
    }

    if (running.kind === 'questions') {
      const questions = await generateQuestionsFromCurriculum({
        settings,
        topicTitle: running.title,
        chunks,
        count: 4,
        signal: options.signal,
      });
      if (running.domain === 'cfa') {
        await saveCachedGeneratedQuestions(running.level, running.topic, questions);
      }
    } else if (running.kind === 'flashcards') {
      const cards = await generateFlashcardsFromCurriculum({
        settings,
        topicTitle: running.title,
        chunks,
        count: 6,
        signal: options.signal,
      });
      if (running.domain === 'cfa') {
        await saveCachedGeneratedFlashcards(running.level, running.topic, cards);
      }
    } else if (running.kind === 'summary') {
      const summary = await summarizeTopicFromCurriculum({
        settings,
        topicTitle: running.title,
        chunks,
        signal: options.signal,
      });
      if (running.domain === 'cfa') {
        await saveCachedTopicSummary(running.level, running.topic, summary);
      }
    } else {
      throw new Error(`Unknown job kind: ${running.kind}`);
    }

    updated = {
      ...running,
      status: 'done',
      completedAt: new Date().toISOString(),
      error: undefined,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      updated = {
        ...running,
        status: 'pending',
        completedAt: undefined,
        error: undefined,
      };
    } else {
      const message = error instanceof Error ? error.message : 'Job failed.';
      updated = {
        ...running,
        status: 'error',
        completedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  const persisted = await readQueue();
  const finalIdx = persisted.findIndex((j) => j.id === updated.id);
  if (finalIdx >= 0) persisted[finalIdx] = updated;
  else persisted.push(updated);
  await writeQueue(persisted);

  return updated;
}
