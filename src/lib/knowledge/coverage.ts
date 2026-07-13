/**
 * CONTENT-2 — LOS-coverage reconciliation.
 *
 * Compares the learning-outcomes the user has ACTUALLY ingested (mined from the
 * curriculum chunks they imported) against the learning objectives the app
 * AUTHORS for each topic, and classifies every authored objective as:
 *
 *   - `covered`   the ingested curriculum contains material matching this
 *                 objective above a confidence floor.
 *   - `partial`   some matching material exists, but below the floor — the
 *                 objective is thinly grounded and at risk.
 *   - `orphan`    no ingested material matches — the objective has NO curriculum
 *                 backing, so grounded study/RAG for it will come up empty.
 *
 * It is PURE + deterministic (no IndexedDB / LLM / network): callers pass in the
 * authored objectives + the mined outcomes (the host reads chunks elsewhere and
 * hands them here), so this is trivially testable and offline-safe.
 *
 * The gaps (`orphan` + `partial`) are then turned into jobs for the EXISTING
 * targeted-material queue via {@link coverageGapsToWeakTopics} +
 * {@link enqueueCoverageGapJobs}, which call `targetedMaterialQueue`'s PUBLIC
 * API (`generateTargetedMaterialJobs`) — this module never rewrites that queue.
 */

import {
  generateTargetedMaterialJobs,
  type TargetedMaterialDomain,
  type TargetedMaterialJob,
  type WeakTopicInput,
} from '../targetedMaterialQueue';

/** An authored learning objective (the app's intended outcome for a topic). */
export interface AuthoredObjective {
  id: string;
  topicId: string;
  title: string;
  /** Optional richer text used for matching (description, key points). */
  description?: string;
  level?: string;
}

/**
 * A learning outcome MINED from ingested curriculum chunks. Callers produce
 * these from the chunk text (e.g. heading/LOS-style lines) before reconciliation.
 */
export interface MinedOutcome {
  /** Free text of the mined outcome / heading. */
  text: string;
  /** The topic id this outcome was mined under, when known. */
  topicId?: string;
  /** Source locator for traceability (page / chunk id). */
  locator?: string;
}

export type CoverageStatus = 'covered' | 'partial' | 'orphan';

export interface ObjectiveCoverage {
  objectiveId: string;
  topicId: string;
  title: string;
  level?: string;
  status: CoverageStatus;
  /** Best match score in [0,1] against the mined outcomes. */
  score: number;
  /** The mined outcome that best matched (when any). */
  matchedOutcome?: MinedOutcome;
}

export interface CoverageReport {
  generatedAt: string;
  total: number;
  covered: number;
  partial: number;
  orphan: number;
  /** Coverage ratio in [0,1] counting `covered` as full and `partial` as half. */
  coverageRatio: number;
  objectives: ObjectiveCoverage[];
}

export interface ReconcileOptions {
  /** Match score at/above which an objective is `covered`. Default 0.5. */
  coveredThreshold?: number;
  /** Match score at/above which an objective is `partial`. Default 0.15. */
  partialThreshold?: number;
  /** Clock for deterministic tests. */
  now?: Date;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'use', 'using', 'with', 'within', 'between', 'across', 'level', 'cfa',
  'describe', 'explain', 'calculate', 'compare', 'identify', 'analyze',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

/**
 * Jaccard-style token overlap weighted toward COVERING the objective: the score
 * is `|objective ∩ outcome| / |objective|`, i.e. "what fraction of the
 * objective's meaningful terms does this outcome cover", which is the right
 * question for coverage (an outcome with lots of extra terms shouldn't be
 * penalised for breadth). Empty objective tokens → 0.
 */
function coverageScore(objectiveTokens: Set<string>, outcomeTokens: Set<string>): number {
  if (objectiveTokens.size === 0) return 0;
  let hits = 0;
  for (const t of objectiveTokens) if (outcomeTokens.has(t)) hits += 1;
  return hits / objectiveTokens.size;
}

/**
 * Reconcile authored objectives against mined outcomes. Pure + deterministic.
 *
 * Topic-aware: when a mined outcome carries a `topicId`, it can only match
 * objectives in the SAME topic (a finance term recurring in another topic
 * shouldn't count as covering this one). Outcomes without a topicId match any
 * objective (a conservative default that can only ever ADD coverage).
 */
export function reconcileCoverage(
  authored: AuthoredObjective[],
  mined: MinedOutcome[],
  options: ReconcileOptions = {},
): CoverageReport {
  const coveredThreshold = options.coveredThreshold ?? 0.5;
  const partialThreshold = options.partialThreshold ?? 0.15;
  const now = options.now ?? new Date();

  const minedTokenized = (mined || []).map((outcome) => ({
    outcome,
    tokens: tokenize(`${outcome.text}`),
  }));

  const objectives: ObjectiveCoverage[] = (authored || []).map((objective) => {
    const objectiveTokens = tokenize(`${objective.title} ${objective.description || ''}`);
    let best = 0;
    let matchedOutcome: MinedOutcome | undefined;
    for (const { outcome, tokens } of minedTokenized) {
      if (outcome.topicId && outcome.topicId !== objective.topicId) continue;
      const score = coverageScore(objectiveTokens, tokens);
      if (score > best) {
        best = score;
        matchedOutcome = outcome;
      }
    }
    const status: CoverageStatus =
      best >= coveredThreshold ? 'covered' : best >= partialThreshold ? 'partial' : 'orphan';
    return {
      objectiveId: objective.id,
      topicId: objective.topicId,
      title: objective.title,
      level: objective.level,
      status,
      score: Number(best.toFixed(4)),
      ...(matchedOutcome ? { matchedOutcome } : {}),
    };
  });

  const covered = objectives.filter((o) => o.status === 'covered').length;
  const partial = objectives.filter((o) => o.status === 'partial').length;
  const orphan = objectives.filter((o) => o.status === 'orphan').length;
  const total = objectives.length;
  const coverageRatio = total === 0 ? 0 : Number(((covered + partial * 0.5) / total).toFixed(4));

  return {
    generatedAt: now.toISOString(),
    total,
    covered,
    partial,
    orphan,
    coverageRatio,
    objectives,
  };
}

export interface CoverageWeakTopicOptions {
  domain?: TargetedMaterialDomain;
  /** Which statuses to treat as gaps. Default `['orphan', 'partial']`. */
  includeStatuses?: CoverageStatus[];
  /** Default level when an objective carries none. Default `'level1'`. */
  defaultLevel?: string;
  /** Map a coverage status to a synthetic mastery (drives the queue threshold). */
  masteryForStatus?: (status: CoverageStatus) => number;
}

/**
 * Translate a coverage report's GAPS into {@link WeakTopicInput}s for the
 * targeted-material queue, ONE per gapped topic (the queue caps jobs per topic
 * itself). A gap status maps to a low synthetic mastery so the queue's
 * `mastery < threshold` gate fires:
 *
 *   - `orphan`  → 0.0  (no grounding at all — strongest signal)
 *   - `partial` → 0.4  (thin grounding — still below the 0.55 default threshold)
 *
 * This is the bridge into the EXISTING queue API; it does NOT enqueue here so
 * callers can inspect/edit the list first.
 */
export function coverageGapsToWeakTopics(
  report: CoverageReport,
  options: CoverageWeakTopicOptions = {},
): WeakTopicInput[] {
  const domain = options.domain ?? 'cfa';
  const includeStatuses = new Set(options.includeStatuses ?? (['orphan', 'partial'] as CoverageStatus[]));
  const defaultLevel = options.defaultLevel ?? 'level1';
  const masteryForStatus =
    options.masteryForStatus ?? ((status: CoverageStatus) => (status === 'orphan' ? 0 : 0.4));

  // Aggregate gaps by topic; the worst (lowest-mastery) status wins so an
  // orphaned objective dominates a merely-partial one in the same topic.
  const byTopic = new Map<string, { level: string; mastery: number; orphan: number; partial: number }>();
  for (const objective of report.objectives) {
    if (!includeStatuses.has(objective.status)) continue;
    const level = objective.level || defaultLevel;
    const mastery = masteryForStatus(objective.status);
    const existing = byTopic.get(objective.topicId);
    if (!existing) {
      byTopic.set(objective.topicId, {
        level,
        mastery,
        orphan: objective.status === 'orphan' ? 1 : 0,
        partial: objective.status === 'partial' ? 1 : 0,
      });
    } else {
      existing.mastery = Math.min(existing.mastery, mastery);
      if (objective.status === 'orphan') existing.orphan += 1;
      else existing.partial += 1;
    }
  }

  return [...byTopic.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([topicId, info]) => ({
      domain,
      level: info.level,
      topic: topicId,
      title: topicTitleFromReport(report, topicId),
      mastery: info.mastery,
    }));
}

function topicTitleFromReport(report: CoverageReport, topicId: string): string {
  // Reuse the first authored title we saw for the topic; fall back to the id.
  const match = report.objectives.find((o) => o.topicId === topicId);
  // Titles are per-objective; for the topic label prefer the topic id humanised.
  return match ? humanizeTopicId(topicId) : humanizeTopicId(topicId);
}

function humanizeTopicId(topicId: string): string {
  return topicId
    .split(/[:\-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface EnqueueCoverageGapResult {
  /** The weak-topics derived from the coverage gaps. */
  weakTopics: WeakTopicInput[];
  /** The full queue after the additive enqueue (from the public queue API). */
  jobs: TargetedMaterialJob[];
}

/**
 * Feed a coverage report's gaps into the EXISTING targeted-material queue by
 * calling its PUBLIC `generateTargetedMaterialJobs` entry point — the queue
 * persists + dedupes the jobs itself. ADDITIVE: this never touches the queue's
 * internals or storage shape. Returns the derived weak-topics + the resulting
 * queue so the UI can show what was enqueued.
 *
 * @param enqueue test seam — defaults to the real queue's
 *   `generateTargetedMaterialJobs`. Tests inject a stub to avoid IndexedDB.
 */
export async function enqueueCoverageGapJobs(
  report: CoverageReport,
  options: CoverageWeakTopicOptions & {
    perTopicLimit?: number;
    threshold?: number;
    now?: Date;
    enqueue?: typeof generateTargetedMaterialJobs;
  } = {},
): Promise<EnqueueCoverageGapResult> {
  const weakTopics = coverageGapsToWeakTopics(report, options);
  if (weakTopics.length === 0) {
    return { weakTopics, jobs: [] };
  }
  const enqueue = options.enqueue ?? generateTargetedMaterialJobs;
  const jobs = await enqueue({
    weakTopics,
    perTopicLimit: options.perTopicLimit,
    threshold: options.threshold,
    now: options.now,
  });
  return { weakTopics, jobs };
}

// --------------------------------------------------------------------------
// Outcome mining helper (pure)
// --------------------------------------------------------------------------

/**
 * Mine candidate learning-outcomes from raw curriculum chunk text. Pure heuristic
 * (no LLM): split into lines, keep LOS-style lines — those that start with a
 * command verb ("describe / explain / calculate / …") OR look like a heading
 * (short, title-ish). The host reads the chunks; this turns their text into the
 * {@link MinedOutcome}s `reconcileCoverage` consumes.
 */
const COMMAND_VERBS = [
  'describe', 'explain', 'calculate', 'compare', 'contrast', 'identify',
  'analyze', 'analyse', 'evaluate', 'interpret', 'determine', 'demonstrate',
  'distinguish', 'estimate', 'derive', 'define', 'discuss', 'recommend',
  'justify', 'formulate', 'construct', 'compute',
];

export function mineOutcomesFromChunks(
  chunks: Array<{ text: string; topicId?: string; locator?: string }>,
): MinedOutcome[] {
  const verbRe = new RegExp(`^(${COMMAND_VERBS.join('|')})\\b`, 'i');
  const outcomes: MinedOutcome[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks || []) {
    const lines = (chunk.text || '')
      .split(/\r?\n|(?<=[.;])\s+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const isCommand = verbRe.test(line);
      const isHeading = line.length <= 90 && /[a-z]/i.test(line) && !/[.]$/.test(line);
      if (!isCommand && !isHeading) continue;
      const key = `${chunk.topicId || ''}|${line.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outcomes.push({
        text: line,
        ...(chunk.topicId ? { topicId: chunk.topicId } : {}),
        ...(chunk.locator ? { locator: chunk.locator } : {}),
      });
    }
  }
  return outcomes;
}
