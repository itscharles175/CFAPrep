import type { QuestionAttempt } from './learningTypes';
import { getStorage } from './storage';
import {
  generateTargetedMaterialJobs,
  jobIdFor,
  readQueue as readTargetedMaterialQueue,
  recoverInterruptedTargetedMaterialJobs,
  type TargetedMaterialDomain,
  type TargetedMaterialJob,
} from './targetedMaterialQueue';

export const REMEDIATION_QUEUE_KEY = 'remediation:queue:v1';

export type RemediationTrigger = 'incorrect' | 'low-confidence' | 'incorrect-and-low-confidence';
export type RemediationStatus = 'open' | 'packet-pending' | 'packet-ready' | 'completed';

export interface RemediationSource {
  sourceId?: string;
  title: string;
  path?: string;
  locator?: string;
}

export interface RemediationAttemptSnapshot {
  attemptKey: string;
  domain: TargetedMaterialDomain;
  level: string;
  topic: string;
  questionId: string;
  learningObjective: string;
  title: string;
  correct: boolean;
  confidence: QuestionAttempt['confidence'];
  errorCategory: QuestionAttempt['errorCategory'];
  selected?: number;
  correctIndex?: number;
  createdAt: string;
}

export interface RemediationQueueEntry {
  id: string;
  attempt: RemediationAttemptSnapshot;
  trigger: RemediationTrigger;
  explanation: string | null;
  supportingMaterial: RemediationSource[];
  evidenceStatus: 'grounded' | 'missing';
  status: RemediationStatus;
  targetedJobId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RemediationEvidence {
  explanation?: string | null;
  supportingMaterial?: RemediationSource[];
}

function cleanPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

export function remediationAttemptKey(attempt: QuestionAttempt): string {
  if (attempt.id != null) return `host-attempt:${attempt.id}`;
  return [
    'host-attempt',
    cleanPart(attempt.domain),
    cleanPart(attempt.topic),
    cleanPart(attempt.learningObjective),
    cleanPart(attempt.questionId),
    cleanPart(attempt.createdAt),
  ].join(':');
}

export function remediationTriggerFor(attempt: QuestionAttempt): RemediationTrigger | null {
  const incorrect = !attempt.correct;
  const lowConfidence = attempt.confidence === 'low';
  if (incorrect && lowConfidence) return 'incorrect-and-low-confidence';
  if (incorrect) return 'incorrect';
  if (lowConfidence) return 'low-confidence';
  return null;
}

export async function readRemediationQueue(): Promise<RemediationQueueEntry[]> {
  try {
    const row = await getStorage().settings.get(REMEDIATION_QUEUE_KEY);
    return Array.isArray(row?.value) ? (row.value as RemediationQueueEntry[]) : [];
  } catch {
    return [];
  }
}

export async function writeRemediationQueue(entries: RemediationQueueEntry[]): Promise<void> {
  await getStorage().settings.put({
    key: REMEDIATION_QUEUE_KEY,
    value: entries,
    updatedAt: new Date().toISOString(),
  });
}

export async function enqueueRemediationAttempt(
  attempt: QuestionAttempt,
  evidence: RemediationEvidence = {},
  options: { now?: Date; defaultLevel?: string } = {},
): Promise<RemediationQueueEntry | null> {
  const trigger = remediationTriggerFor(attempt);
  if (!trigger) return null;

  const entries = await readRemediationQueue();
  const attemptKey = remediationAttemptKey(attempt);
  const existing = entries.find((entry) => entry.attempt.attemptKey === attemptKey);
  if (existing) return existing;

  const now = (options.now ?? new Date()).toISOString();
  const supportingMaterial = evidence.supportingMaterial ?? [];
  const level = attempt.level || options.defaultLevel || 'level1';
  const title = attempt.objectiveTitle || attempt.title || attempt.learningObjective;
  const entry: RemediationQueueEntry = {
    id: `remediation:${attemptKey}`,
    attempt: {
      attemptKey,
      domain: attempt.domain,
      level,
      topic: attempt.topic,
      questionId: attempt.questionId,
      learningObjective: attempt.learningObjective,
      title,
      correct: attempt.correct,
      confidence: attempt.confidence,
      errorCategory: attempt.errorCategory,
      selected: attempt.selected,
      correctIndex: attempt.correctIndex,
      createdAt: attempt.createdAt || now,
    },
    trigger,
    explanation: evidence.explanation ?? null,
    supportingMaterial,
    evidenceStatus: evidence.explanation || supportingMaterial.length ? 'grounded' : 'missing',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };

  entries.push(entry);
  await writeRemediationQueue(entries);
  return entry;
}

/** Reconcile the append-only host attempt log into the durable remediation queue. */
export async function reconcileRemediationAttempts(
  attempts: QuestionAttempt[],
  options: { now?: Date; defaultLevel?: string } = {},
): Promise<RemediationQueueEntry[]> {
  for (const attempt of attempts) {
    await enqueueRemediationAttempt(attempt, {}, options);
  }
  return readRemediationQueue();
}

/** One-call startup bridge from the active host attempt store into remediation. */
export async function reconcileStoredRemediationAttempts(
  options: { now?: Date; defaultLevel?: string } = {},
): Promise<RemediationQueueEntry[]> {
  const attempts = await getStorage().questionResults?.toArray();
  return reconcileRemediationAttempts(attempts ?? [], options);
}

/**
 * Create one question packet per affected topic and link every open mistake in
 * that topic to the same deduplicated targeted-material job.
 */
export async function enqueueRemediationPracticePackets(
  entries: RemediationQueueEntry[] = [],
  options: { now?: Date } = {},
): Promise<{ entries: RemediationQueueEntry[]; jobs: TargetedMaterialJob[] }> {
  const queue = entries.length ? entries : await readRemediationQueue();
  const actionable = queue.filter((entry) => entry.status !== 'completed');
  if (!actionable.length) return { entries: queue, jobs: await readTargetedMaterialQueue() };

  const weakTopics = Array.from(
    new Map(
      actionable.map((entry) => [
        `${entry.attempt.domain}:${entry.attempt.level}:${entry.attempt.topic}`,
        {
          domain: entry.attempt.domain,
          level: entry.attempt.level,
          topic: entry.attempt.topic,
          title: entry.attempt.title,
          mastery: 0,
        },
      ]),
    ).values(),
  );
  const jobs = await generateTargetedMaterialJobs({ weakTopics, perTopicLimit: 1, now: options.now });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const now = (options.now ?? new Date()).toISOString();
  const updated = queue.map((entry) => {
    if (entry.status === 'completed') return entry;
    const targetedJobId = jobIdFor(entry.attempt.domain, entry.attempt.level, entry.attempt.topic, 'questions');
    const job = jobsById.get(targetedJobId);
    return {
      ...entry,
      targetedJobId: job ? targetedJobId : entry.targetedJobId,
      status: job?.status === 'done' || !job ? ('packet-ready' as const) : ('packet-pending' as const),
      updatedAt: now,
    };
  });
  await writeRemediationQueue(updated);
  return { entries: updated, jobs };
}

/** Restore interrupted generation and reflect packet completion in remediation. */
export async function recoverRemediationWork(options: { now?: Date } = {}): Promise<RemediationQueueEntry[]> {
  const jobs = await recoverInterruptedTargetedMaterialJobs();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const entries = await readRemediationQueue();
  const now = (options.now ?? new Date()).toISOString();
  const recovered = entries.map((entry) => {
    if (entry.status === 'completed' || !entry.targetedJobId) return entry;
    const job = jobsById.get(entry.targetedJobId);
    if (!job) return { ...entry, status: 'open' as const, targetedJobId: undefined, updatedAt: now };
    return {
      ...entry,
      status: job.status === 'done' ? ('packet-ready' as const) : ('packet-pending' as const),
      updatedAt: now,
    };
  });
  await writeRemediationQueue(recovered);
  return recovered;
}

export async function completeRemediationEntry(
  id: string,
  options: { now?: Date } = {},
): Promise<RemediationQueueEntry[]> {
  const entries = await readRemediationQueue();
  const now = (options.now ?? new Date()).toISOString();
  const updated = entries.map((entry) =>
    entry.id === id ? { ...entry, status: 'completed' as const, completedAt: now, updatedAt: now } : entry,
  );
  await writeRemediationQueue(updated);
  return updated;
}
