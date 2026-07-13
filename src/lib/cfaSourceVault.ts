import { db } from './progressStore';
import type {
  CfaSourceBundle,
  CfaSourceChunk,
  CfaSourceCoverageMap,
  CfaSourceDocument,
  CfaSourceFreshnessDiagnostics,
  CfaSourceHealthIssue,
  CfaSourceHealthReport,
  CfaSourceIndex,
  CfaSourceIngestionRun,
  CfaSourceLevel,
  CfaSourceLink,
  CfaSourceLinkOverride,
  CfaSourceMapStatus,
  CfaSourcePolicy,
  CfaSourcePriority,
  CfaSourceSearchResult,
  CfaSourceSnippet,
  CfaSourceTarget,
  CfaSourceVaultStores,
} from './cfaSourceTypes';
import { decryptSourceChunksForRead, encryptSourceChunksForStorage } from './sourceChunkSecureVault';

export type {
  CfaSourceBundle,
  CfaSourceChunk,
  CfaSourceCoverageMap,
  CfaSourceDocument,
  CfaSourceFreshnessDiagnostics,
  CfaSourceHealthIssue,
  CfaSourceHealthReport,
  CfaSourceIndex,
  CfaSourceIngestionRun,
  CfaSourceLink,
  CfaSourceLinkOverride,
  CfaSourceMapStatus,
  CfaSourcePolicy,
  CfaSourceSnippet,
  CfaSourceTarget,
  CfaSourceSearchResult,
  CfaSourceVaultStores,
} from './cfaSourceTypes';

export const CFA_SOURCE_POLICY: CfaSourcePolicy = {
  privateUseOnly: true,
  allowStandardExport: false,
  textStorage: 'indexeddb',
  notes:
    'User-provided CFA materials are stored only in the private local source vault or .qvsource bundles. Standard QuantVault exports omit source text.',
};

const SOURCE_SNIPPET_LIMIT = 360;
const DEFAULT_SOURCE_STALE_AFTER_DAYS = 180;
const STOP_WORDS = new Set([
  'and',
  'are',
  'but',
  'cfa',
  'for',
  'from',
  'into',
  'level',
  'module',
  'most',
  'that',
  'the',
  'this',
  'with',
  'your',
]);

export function emptyCfaSourceVaultStores(): CfaSourceVaultStores {
  return {
    sourceDocuments: [],
    sourceChunks: [],
    sourceIndexes: [],
    sourceIngestionRuns: [],
    sourceLinks: [],
    sourceLinkOverrides: [],
  };
}

export function normalizeCfaSourceText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function searchTerms(query: string) {
  return sourceTerms([query], 1);
}

function sourceTerms(values: Array<string | undefined>, minLength = 3) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((value) => normalizeCfaSourceText(value as string).split(/\s+/))
        .filter((term) => term.length >= minLength && !STOP_WORDS.has(term)),
    ),
  ];
}

function previewFor(text: string, terms: string[], maxLength = 220) {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!terms.length) return cleanText.slice(0, maxLength);
  const lower = text.toLowerCase();
  const firstHit =
    terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - Math.round(maxLength * 0.35));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '...' : ''}${cleanText.slice(start, end)}${end < cleanText.length ? '...' : ''}`;
}

function validPolicy(policy: CfaSourcePolicy | undefined): CfaSourcePolicy {
  return {
    ...CFA_SOURCE_POLICY,
    ...(policy || {}),
    privateUseOnly: true,
    allowStandardExport: false,
  };
}

export function buildCfaSourceTarget(target: Omit<CfaSourceTarget, 'id'> & { id?: string }): CfaSourceTarget {
  const id =
    target.id ||
    [
      'source-target',
      target.kind,
      target.domain || 'local',
      target.level || 'any',
      target.topicId || 'all',
      ...(target.pathway ? [target.pathway] : []),
      normalizeCfaSourceText(target.title).replace(/\s+/g, '-').slice(0, 72) || 'untitled',
    ].join(':');
  return {
    ...target,
    id,
  };
}

function sourcePriorityFor(document: CfaSourceDocument): CfaSourcePriority {
  if (document.sourceKind === 'official-curriculum' && document.canonical) return 'official-canonical';
  if (document.sourceKind === 'official-curriculum') return 'official-mirror';
  if (document.sourceKind === 'prep-provider') return 'prep-provider';
  if (document.sourceKind === 'reference-book') return 'reference';
  return 'user-source';
}

function priorityScore(priority: CfaSourcePriority) {
  const scores: Record<CfaSourcePriority, number> = {
    'official-canonical': 10000,
    'official-mirror': 8500,
    'prep-provider': 6500,
    reference: 4500,
    'user-source': 3000,
  };
  return scores[priority];
}

function termsForTarget(target: CfaSourceTarget) {
  return sourceTerms([
    target.title,
    target.topicId,
    target.pathway,
    ...(target.objectiveIds || []),
    ...(target.formulaNames || []),
    ...(target.keywords || []),
  ]);
}

function pathwayTopicId(pathway?: CfaSourceTarget['pathway']) {
  if (pathway === 'private-markets') return 'private-markets-pathway';
  if (pathway === 'private-wealth') return 'private-wealth-pathway';
  if (pathway === 'portfolio-management') return 'pm-pathway';
  return undefined;
}

function scoreSourceCandidate({
  target,
  document,
  chunk,
  terms,
}: {
  target: CfaSourceTarget;
  document: CfaSourceDocument;
  chunk: CfaSourceChunk;
  terms: string[];
}) {
  const priority = sourcePriorityFor(document);
  const normalized = chunk.normalizedText || normalizeCfaSourceText(chunk.text);
  const documentTerms = sourceTerms([document.title, document.publisher, document.level, ...document.topicIds]);
  const matchedTerms = terms.filter((term) => normalized.includes(term) || documentTerms.includes(term));
  const topicMatch = Boolean(
    target.topicId && (document.topicIds.includes(target.topicId) || chunk.topicIds.includes(target.topicId)),
  );
  const levelMatch = Boolean(target.level && document.level === target.level);
  const pathwayTopic = pathwayTopicId(target.pathway);
  const pathwayMatch = Boolean(
    pathwayTopic && (document.topicIds.includes(pathwayTopic) || chunk.topicIds.includes(pathwayTopic)),
  );
  const formulaMatch = (target.formulaNames || []).some((formula) =>
    normalized.includes(normalizeCfaSourceText(formula)),
  );
  const relevant = matchedTerms.length > 0 || topicMatch || pathwayMatch || formulaMatch;
  if (!relevant) return null;
  const yearScore = typeof document.year === 'number' ? Math.max(0, Math.min(30, document.year - 2020)) : 0;
  const score =
    priorityScore(priority) +
    matchedTerms.length * 24 +
    (levelMatch ? 180 : 0) +
    (topicMatch ? 260 : 0) +
    (pathwayMatch ? 320 : 0) +
    (formulaMatch ? 180 : 0) +
    (document.canonical ? 60 : 0) +
    yearScore;
  const reasons = [
    priority === 'official-canonical' ? 'official canonical source' : priority.replace('-', ' '),
    levelMatch ? `${target.level} match` : '',
    topicMatch ? `${target.topicId} match` : '',
    pathwayMatch ? `${target.pathway} pathway match` : '',
    formulaMatch ? 'formula match' : '',
    matchedTerms.length ? `${matchedTerms.length} term match${matchedTerms.length === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  return { score, priority, matchedTerms, rankReason: reasons.join(' · ') };
}

function linkIdFor(targetId: string, chunkId: string) {
  return `${targetId}::${chunkId}`;
}

function overrideIdFor(targetId: string, chunkId: string) {
  return `${targetId}::${chunkId}`;
}

function clampSnippet(text: string, terms: string[]) {
  return previewFor(text, terms, SOURCE_SNIPPET_LIMIT);
}

function isoTime(value: string | undefined) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

function latestIso(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value && isoTime(value) !== undefined))
    .sort((a, b) => b.localeCompare(a))[0];
}

function staleCutoff(asOf: Date, staleAfterDays: number) {
  return asOf.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
}

function isStaleIso(value: string | undefined, cutoff: number) {
  const time = isoTime(value);
  return time !== undefined && time < cutoff;
}

async function candidateChunksForTerms(terms: string[], documentIds?: Set<string>) {
  if (!terms.length && !documentIds?.size) return [];
  const indexRows = terms.length
    ? ((await db.sourceIndexes.bulkGet(terms.map((term) => `token:${term}`))).filter(Boolean) as CfaSourceIndex[])
    : [];
  const indexedChunkIds = new Set(indexRows.flatMap((row) => row.chunkIds));
  const chunksById = new Map<string, CfaSourceChunk>();
  if (indexedChunkIds.size) {
    const indexedChunks = await decryptSourceChunksForRead(
      (await db.sourceChunks.bulkGet([...indexedChunkIds])).filter(Boolean) as CfaSourceChunk[],
    );
    indexedChunks.forEach((chunk) => {
      if (!documentIds?.size || documentIds.has(chunk.documentId)) chunksById.set(chunk.id, chunk);
    });
  }
  if (documentIds?.size) {
    const documentChunks = await decryptSourceChunksForRead(
      await db.sourceChunks
        .where('documentId')
        .anyOf([...documentIds])
        .toArray(),
    );
    documentChunks.forEach((chunk) => chunksById.set(chunk.id, chunk));
  }
  if (terms.length && (!indexedChunkIds.size || indexRows.length < terms.length)) {
    const fallbackChunks = await decryptSourceChunksForRead(await db.sourceChunks.toArray());
    fallbackChunks
      .filter((chunk) => !documentIds?.size || documentIds.has(chunk.documentId))
      .filter((chunk) => {
        const normalized = chunk.normalizedText || normalizeCfaSourceText(chunk.text);
        return terms.some((term) => normalized.includes(term));
      })
      .forEach((chunk) => chunksById.set(chunk.id, chunk));
  }
  return [...chunksById.values()];
}

export function buildCfaSourceIndexRows(
  chunks: CfaSourceChunk[],
  updatedAt = new Date().toISOString(),
): CfaSourceIndex[] {
  const tokenMap = new Map<string, { documentIds: Set<string>; chunkIds: Set<string> }>();
  chunks.forEach((chunk) => {
    const tokens = new Set(chunk.normalizedText.split(/\s+/).filter((token) => token.length > 2));
    tokens.forEach((token) => {
      const row = tokenMap.get(token) || { documentIds: new Set<string>(), chunkIds: new Set<string>() };
      row.documentIds.add(chunk.documentId);
      row.chunkIds.add(chunk.id);
      tokenMap.set(token, row);
    });
  });
  return [...tokenMap.entries()].map(([token, row]) => ({
    id: `token:${token}`,
    token,
    documentIds: [...row.documentIds].sort(),
    chunkIds: [...row.chunkIds].sort(),
    updatedAt,
  }));
}

function portableSourceDocument(document: CfaSourceDocument): CfaSourceDocument {
  const { path, archivePath, archiveMemberPath, ...rest } = document;
  const portablePath = [archiveMemberPath, path]
    .find((value) => value && !/^[a-z]:[\\/]/i.test(value) && !value.startsWith('/') && !value.includes('..'))
    ?.replaceAll('\\', '/');
  return portablePath ? { ...rest, path: portablePath } : rest;
}

function portableSourceRun(run: CfaSourceIngestionRun): CfaSourceIngestionRun {
  return {
    ...run,
    rootPath: '<private-local-source-root>',
  };
}

export function buildCfaSourceBundle({
  documents,
  chunks,
  indexes,
  runs,
  policy = CFA_SOURCE_POLICY,
  createdAt = new Date().toISOString(),
}: {
  documents: CfaSourceDocument[];
  chunks: CfaSourceChunk[];
  indexes?: CfaSourceIndex[];
  runs?: CfaSourceIngestionRun[];
  policy?: CfaSourcePolicy;
  createdAt?: string;
}): CfaSourceBundle {
  return {
    app: 'QuantVault',
    kind: 'cfa-source-vault',
    bundleVersion: 1,
    createdAt,
    policy: validPolicy(policy),
    documents: documents.map((document) => ({ ...portableSourceDocument(document), privateUseOnly: true })),
    chunks: chunks.map((chunk) => ({
      ...chunk,
      normalizedText: chunk.normalizedText || normalizeCfaSourceText(chunk.text),
    })),
    indexes,
    runs: runs?.map(portableSourceRun),
  };
}

export function validateCfaSourceBundle(payload: unknown): {
  valid: boolean;
  errors: string[];
  bundle?: CfaSourceBundle;
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Source bundle must be a JSON object.'] };
  }
  const candidate = payload as Partial<CfaSourceBundle>;
  if (candidate.app !== 'QuantVault') errors.push('Source bundle app must be QuantVault.');
  if (candidate.kind !== 'cfa-source-vault') errors.push('Source bundle kind must be cfa-source-vault.');
  if (candidate.bundleVersion !== 1) errors.push('Source bundle version must be 1.');
  if (!Array.isArray(candidate.documents)) errors.push('Source bundle documents must be an array.');
  if (!Array.isArray(candidate.chunks)) errors.push('Source bundle chunks must be an array.');
  const documents = Array.isArray(candidate.documents) ? candidate.documents : [];
  const chunks = Array.isArray(candidate.chunks) ? candidate.chunks : [];
  const documentIds = new Set(documents.map((document) => document.id));
  documents.forEach((document) => {
    if (!document.id || !document.title || !document.sha256)
      errors.push(`Source document ${document.id || '<missing>'} is missing required metadata.`);
    if (document.privateUseOnly !== true)
      errors.push(`Source document ${document.id || '<missing>'} must be marked privateUseOnly.`);
  });
  chunks.forEach((chunk) => {
    if (!chunk.id || !chunk.documentId || !chunk.text)
      errors.push(`Source chunk ${chunk.id || '<missing>'} is missing required text metadata.`);
    if (chunk.documentId && !documentIds.has(chunk.documentId))
      errors.push(`Source chunk ${chunk.id || '<missing>'} references an unknown document.`);
  });
  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    bundle: buildCfaSourceBundle({
      documents: documents as CfaSourceDocument[],
      chunks: chunks as CfaSourceChunk[],
      indexes: Array.isArray(candidate.indexes) ? (candidate.indexes as CfaSourceIndex[]) : undefined,
      runs: Array.isArray(candidate.runs) ? (candidate.runs as CfaSourceIngestionRun[]) : undefined,
      policy: validPolicy(candidate.policy),
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    }),
  };
}

export async function importCfaSourceBundle(payload: unknown, options: { mode?: 'replace' | 'merge' } = {}) {
  const validation = validateCfaSourceBundle(payload);
  if (!validation.valid || !validation.bundle) throw new Error(validation.errors.join(' '));
  const bundle = validation.bundle;
  const indexes = bundle.indexes?.length ? bundle.indexes : buildCfaSourceIndexRows(bundle.chunks);
  const chunksForStorage = await encryptSourceChunksForStorage(bundle.chunks);
  const mode = options.mode || 'replace';
  await db.transaction(
    'rw',
    [
      db.sourceDocuments,
      db.sourceChunks,
      db.sourceIndexes,
      db.sourceIngestionRuns,
      db.sourceLinks,
      db.sourceLinkOverrides,
    ],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.sourceDocuments.clear(),
          db.sourceChunks.clear(),
          db.sourceIndexes.clear(),
          db.sourceIngestionRuns.clear(),
          db.sourceLinks.clear(),
          db.sourceLinkOverrides.clear(),
        ]);
      }
      await Promise.all([
        db.sourceDocuments.bulkPut(bundle.documents),
        db.sourceChunks.bulkPut(chunksForStorage),
        db.sourceIndexes.bulkPut(indexes),
        db.sourceIngestionRuns.bulkPut(bundle.runs || []),
        db.sourceLinks.clear(),
      ]);
      if (mode === 'merge') {
        const chunkIds = new Set((await db.sourceChunks.toArray()).map((chunk) => chunk.id));
        const staleOverrides = (await db.sourceLinkOverrides.toArray()).filter(
          (override) => !chunkIds.has(override.chunkId),
        );
        await db.sourceLinkOverrides.bulkDelete(staleOverrides.map((override) => override.id));
      }
    },
  );
  return {
    documents: bundle.documents.length,
    chunks: bundle.chunks.length,
    indexes: indexes.length,
    mode,
  };
}

export async function exportCfaSourceBundle(documentIds?: string[]) {
  const documents = documentIds?.length
    ? await db.sourceDocuments.bulkGet(documentIds)
    : await db.sourceDocuments.toArray();
  const filteredDocuments = documents.filter(Boolean) as CfaSourceDocument[];
  const ids = new Set(filteredDocuments.map((document) => document.id));
  const chunks = await decryptSourceChunksForRead((await db.sourceChunks.toArray()).filter((chunk) => ids.has(chunk.documentId)));
  const indexes = buildCfaSourceIndexRows(chunks);
  const runs = await db.sourceIngestionRuns.toArray();
  return buildCfaSourceBundle({ documents: filteredDocuments, chunks, indexes, runs });
}

export async function getCfaSourceDocuments() {
  return db.sourceDocuments.orderBy('importedAt').reverse().toArray();
}

export async function getCfaSourceChunks(documentId: string) {
  return decryptSourceChunksForRead(await db.sourceChunks.where('documentId').equals(documentId).sortBy('chunkIndex'));
}

// Ordered curriculum reading for a topic: the best-matching ingested document
// (canonical first, then most chunks) and its chunks in page order. Used to show
// the real curriculum text in-app, with authored lessons as the fallback when a
// topic has no ingested source.
export async function getCfaSourceReadingForTopic(
  level: string,
  topicId: string,
): Promise<{ document: CfaSourceDocument | null; chunks: CfaSourceChunk[] }> {
  if (!topicId) return { document: null, chunks: [] };
  const documents = await db.sourceDocuments.toArray();
  const matches = documents.filter(
    (document) => document.topicIds.includes(topicId) && (!level || document.level === level),
  );
  const best = matches.sort(
    (a, b) => Number(Boolean(b.canonical)) - Number(Boolean(a.canonical)) || (b.chunkCount || 0) - (a.chunkCount || 0),
  )[0];
  if (!best) return { document: null, chunks: [] };
  const chunks = await decryptSourceChunksForRead(await db.sourceChunks.where('documentId').equals(best.id).sortBy('chunkIndex'));
  return { document: best, chunks };
}

export async function searchCfaSourceVault(query: string, limit = 8): Promise<CfaSourceSearchResult[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const [chunks, documents] = await Promise.all([candidateChunksForTerms(terms), db.sourceDocuments.toArray()]);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  return chunks
    .map((chunk) => {
      const normalized = chunk.normalizedText || normalizeCfaSourceText(chunk.text);
      const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
      const document = documentsById.get(chunk.documentId);
      const sourceScore = document ? priorityScore(sourcePriorityFor(document)) / 1000 : 0;
      return document && score > 0
        ? { document, chunk, score: score + sourceScore, preview: previewFor(chunk.text, terms) }
        : null;
    })
    .filter((row): row is CfaSourceSearchResult => Boolean(row))
    .sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title))
    .slice(0, limit);
}

export async function rebuildCfaSourceLinksForTarget(
  targetInput: CfaSourceTarget,
  limit = 6,
): Promise<CfaSourceLink[]> {
  const target = buildCfaSourceTarget(targetInput);
  const terms = termsForTarget(target);
  const pathwayTopic = pathwayTopicId(target.pathway);
  const documents = await db.sourceDocuments.toArray();
  const matchingDocumentIds = new Set(
    documents
      .filter((document) => {
        const levelMatch = !target.level || document.level === target.level;
        const topicMatch = Boolean(target.topicId && document.topicIds.includes(target.topicId));
        const pathwayMatch = Boolean(pathwayTopic && document.topicIds.includes(pathwayTopic));
        return levelMatch && (topicMatch || pathwayMatch);
      })
      .map((document) => document.id),
  );
  const indexRows = (await db.sourceIndexes.bulkGet(terms.map((term) => `token:${term}`))).filter(
    Boolean,
  ) as CfaSourceIndex[];
  const indexedDocumentIds = new Set(indexRows.flatMap((row) => row.documentIds));
  const candidateDocumentIds = new Set([...matchingDocumentIds, ...indexedDocumentIds]);
  const chunks = await candidateChunksForTerms(terms, candidateDocumentIds.size ? candidateDocumentIds : undefined);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const candidates = chunks
    .map((chunk) => {
      const document = documentsById.get(chunk.documentId);
      if (!document) return null;
      const scored = scoreSourceCandidate({ target, document, chunk, terms });
      if (!scored) return null;
      return { chunk, document, ...scored };
    })
    .filter(
      (
        row,
      ): row is {
        chunk: CfaSourceChunk;
        document: CfaSourceDocument;
        score: number;
        priority: CfaSourcePriority;
        matchedTerms: string[];
        rankReason: string;
      } => Boolean(row),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.document.title.localeCompare(b.document.title) ||
        a.chunk.chunkIndex - b.chunk.chunkIndex,
    );

  const documentUse = new Map<string, number>();
  const selected = [];
  for (const candidate of candidates) {
    const used = documentUse.get(candidate.document.id) || 0;
    if (used >= 2) continue;
    selected.push(candidate);
    documentUse.set(candidate.document.id, used + 1);
    if (selected.length >= limit) break;
  }

  const createdAt = new Date().toISOString();
  const links: CfaSourceLink[] = selected.map((candidate, index) => ({
    id: linkIdFor(target.id, candidate.chunk.id),
    targetId: target.id,
    targetKind: target.kind,
    documentId: candidate.document.id,
    chunkId: candidate.chunk.id,
    score: candidate.score,
    rank: index + 1,
    sourcePriority: candidate.priority,
    matchedTerms: candidate.matchedTerms,
    rankReason: candidate.rankReason,
    createdAt,
  }));
  await db.transaction('rw', [db.sourceLinks], async () => {
    const existing = (await db.sourceLinks.where('targetId').equals(target.id).primaryKeys()) as string[];
    await db.sourceLinks.bulkDelete(existing);
    await db.sourceLinks.bulkPut(links);
  });
  return links;
}

export async function rebuildCfaSourceLinksForTargets(targets: CfaSourceTarget[], limit = 6) {
  const results = await Promise.all(targets.map((target) => rebuildCfaSourceLinksForTarget(target, limit)));
  return {
    targets: targets.length,
    links: results.reduce((sum, links) => sum + links.length, 0),
  };
}

async function linksForTarget(targetInput: CfaSourceTarget, limit = 6) {
  const target = buildCfaSourceTarget(targetInput);
  const existing = await db.sourceLinks.where('targetId').equals(target.id).sortBy('rank');
  return existing.slice(0, limit);
}

export async function getCfaSourceSnippetsForTarget(
  targetInput: CfaSourceTarget,
  limit = 4,
): Promise<CfaSourceSnippet[]> {
  const target = buildCfaSourceTarget(targetInput);
  const [links, overrides, documents, chunks] = await Promise.all([
    linksForTarget(target, Math.max(limit * 2, 6)),
    db.sourceLinkOverrides.where('targetId').equals(target.id).toArray(),
    db.sourceDocuments.toArray(),
    decryptSourceChunksForRead(await db.sourceChunks.toArray()),
  ]);
  const overrideByChunk = new Map(overrides.map((override) => [override.chunkId, override]));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const terms = termsForTarget(target);
  return links
    .map((link) => {
      const document = documentsById.get(link.documentId);
      const chunk = chunksById.get(link.chunkId);
      if (!document || !chunk) return null;
      const override = overrideByChunk.get(link.chunkId);
      return {
        targetId: target.id,
        link,
        document,
        chunk,
        preview: clampSnippet(chunk.text, link.matchedTerms.length ? link.matchedTerms : terms),
        pinned: override?.action === 'pin',
        dismissed: override?.action === 'dismiss',
      };
    })
    .filter((row): row is CfaSourceSnippet => row !== null && !row.dismissed)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.link.rank - b.link.rank)
    .slice(0, limit);
}

export async function setCfaSourceLinkOverride(
  targetId: string,
  chunkId: string,
  action: CfaSourceLinkOverride['action'],
) {
  const override: CfaSourceLinkOverride = {
    id: overrideIdFor(targetId, chunkId),
    targetId,
    chunkId,
    action,
    updatedAt: new Date().toISOString(),
  };
  await db.sourceLinkOverrides.put(override);
  return override;
}

export async function clearCfaSourceLinkOverride(targetId: string, chunkId: string) {
  await db.sourceLinkOverrides.delete(overrideIdFor(targetId, chunkId));
}

export async function getCfaSourceMapStatus(): Promise<CfaSourceMapStatus> {
  const [documentCount, chunkCount, linkCount, overrideCount, documents, links] = await Promise.all([
    db.sourceDocuments.count(),
    db.sourceChunks.count(),
    db.sourceLinks.count(),
    db.sourceLinkOverrides.count(),
    db.sourceDocuments.toArray(),
    db.sourceLinks.toArray(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    documentCount,
    chunkCount,
    linkCount,
    overrideCount,
    officialDocumentCount: documents.filter((document) => document.sourceKind === 'official-curriculum').length,
    targetCount: new Set(links.map((link) => link.targetId)).size,
  };
}

export async function getCfaSourceCoverageMap(): Promise<CfaSourceCoverageMap> {
  const [documents, chunks] = await Promise.all([db.sourceDocuments.toArray(), db.sourceChunks.toArray()]);
  const levelCounts = documents.reduce(
    (counts, document) => ({ ...counts, [document.level]: (counts[document.level] || 0) + 1 }),
    { level1: 0, level2: 0, level3: 0, prerequisite: 0, reference: 0, unknown: 0 } as Record<CfaSourceLevel, number>,
  );
  const topicCounts: Record<string, number> = {};
  documents.forEach((document) => {
    document.topicIds.forEach((topicId) => {
      topicCounts[topicId] = (topicCounts[topicId] || 0) + 1;
    });
  });
  const chunksByDocument = chunks.reduce(
    (counts, chunk) => {
      counts[chunk.documentId] = (counts[chunk.documentId] || 0) + 1;
      return counts;
    },
    {} as Record<string, number>,
  );
  return {
    generatedAt: new Date().toISOString(),
    documentCount: documents.length,
    chunkCount: chunks.length,
    levelCounts,
    topicCounts,
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title,
      level: document.level,
      year: document.year,
      publisher: document.publisher,
      topicIds: document.topicIds,
      chunkCount: chunksByDocument[document.id] || document.chunkCount,
      needsOcr: document.needsOcr,
    })),
  };
}

export async function getCfaSourceFreshnessDiagnostics({
  asOf = new Date(),
  staleAfterDays = DEFAULT_SOURCE_STALE_AFTER_DAYS,
}: {
  asOf?: Date;
  staleAfterDays?: number;
} = {}): Promise<CfaSourceFreshnessDiagnostics> {
  const [documents, runs] = await Promise.all([db.sourceDocuments.toArray(), db.sourceIngestionRuns.toArray()]);
  const cutoff = staleCutoff(asOf, staleAfterDays);
  const staleDocuments = documents.filter((document) => isStaleIso(document.importedAt, cutoff));
  const staleRuns = runs.filter((run) => isStaleIso(run.completedAt || run.startedAt, cutoff));
  const diagnostics: CfaSourceHealthIssue[] = [
    ...staleDocuments.map((document) => ({
      code: 'stale-source-document' as const,
      severity: 'warning' as const,
      documentId: document.id,
      message: `${document.title} was imported more than ${staleAfterDays} day(s) ago.`,
    })),
    ...staleRuns.map((run) => ({
      code: 'stale-ingestion-run' as const,
      severity: 'warning' as const,
      runId: run.id,
      message: `Source ingestion run ${run.id} is older than ${staleAfterDays} day(s).`,
    })),
  ];
  return {
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    staleAfterDays,
    latestImportAt: latestIso(documents.map((document) => document.importedAt)),
    latestRunCompletedAt: latestIso(runs.map((run) => run.completedAt || run.startedAt)),
    stale: diagnostics.length > 0,
    staleDocumentIds: staleDocuments.map((document) => document.id),
    staleRunIds: staleRuns.map((run) => run.id),
    diagnostics,
  };
}

export async function getCfaSourceHealthReport({
  asOf = new Date(),
  staleAfterDays = DEFAULT_SOURCE_STALE_AFTER_DAYS,
}: {
  asOf?: Date;
  staleAfterDays?: number;
} = {}): Promise<CfaSourceHealthReport> {
  const [documents, chunks, indexes, runs, links, freshness] = await Promise.all([
    db.sourceDocuments.toArray(),
    db.sourceChunks.toArray(),
    db.sourceIndexes.toArray(),
    db.sourceIngestionRuns.toArray(),
    db.sourceLinks.toArray(),
    getCfaSourceFreshnessDiagnostics({ asOf, staleAfterDays }),
  ]);
  const documentIds = new Set(documents.map((document) => document.id));
  const chunkIds = new Set(chunks.map((chunk) => chunk.id));
  const chunkCounts = chunks.reduce(
    (counts, chunk) => {
      counts[chunk.documentId] = (counts[chunk.documentId] || 0) + 1;
      return counts;
    },
    {} as Record<string, number>,
  );
  const orphanedChunks = chunks.filter((chunk) => !documentIds.has(chunk.documentId));
  const orphanedIndexChunkIds = [
    ...new Set(indexes.flatMap((index) => index.chunkIds).filter((chunkId) => !chunkIds.has(chunkId))),
  ];
  const orphanedLinks = links.filter((link) => !documentIds.has(link.documentId) || !chunkIds.has(link.chunkId));
  const zeroChunkPdfs = documents.filter(
    (document) => document.format === 'pdf' && (chunkCounts[document.id] || document.chunkCount || 0) === 0,
  );
  const zeroChunkCanonicalPdfs = zeroChunkPdfs.filter((document) => document.canonical);
  const needsOcrDocuments = documents.filter((document) => document.needsOcr);
  const issues: CfaSourceHealthIssue[] = [
    ...zeroChunkCanonicalPdfs.map((document) => ({
      code: 'zero-chunk-canonical-pdf' as const,
      severity: 'blocked' as const,
      documentId: document.id,
      message: `${document.title} is a canonical PDF with no searchable chunks.`,
    })),
    ...needsOcrDocuments.map((document) => ({
      code: 'needs-ocr' as const,
      severity: 'blocked' as const,
      documentId: document.id,
      message: `${document.title} needs OCR or a searchable companion source.`,
    })),
    orphanedChunks.length
      ? {
          code: 'orphaned-chunk' as const,
          severity: 'warning' as const,
          count: orphanedChunks.length,
          message: `${orphanedChunks.length} source chunk(s) reference missing documents.`,
        }
      : undefined,
    orphanedIndexChunkIds.length
      ? {
          code: 'orphaned-index-chunk' as const,
          severity: 'warning' as const,
          count: orphanedIndexChunkIds.length,
          message: `${orphanedIndexChunkIds.length} source index chunk id(s) no longer exist.`,
        }
      : undefined,
    orphanedLinks.length
      ? {
          code: 'orphaned-link' as const,
          severity: 'warning' as const,
          count: orphanedLinks.length,
          message: `${orphanedLinks.length} source link(s) reference missing source rows.`,
        }
      : undefined,
    ...freshness.diagnostics,
  ].filter((issue): issue is CfaSourceHealthIssue => Boolean(issue));
  const status = issues.some((issue) => issue.severity === 'blocked')
    ? 'blocked'
    : issues.some((issue) => issue.severity === 'warning')
      ? 'warning'
      : 'ok';
  return {
    generatedAt: new Date().toISOString(),
    status,
    documentCount: documents.length,
    chunkCount: chunks.length,
    indexCount: indexes.length,
    runCount: runs.length,
    canonicalDocumentCount: documents.filter((document) => document.canonical).length,
    searchableDocumentCount: documents.filter((document) => (chunkCounts[document.id] || document.chunkCount || 0) > 0)
      .length,
    searchableCanonicalDocumentCount: documents.filter(
      (document) => document.canonical && (chunkCounts[document.id] || document.chunkCount || 0) > 0,
    ).length,
    officialDocumentCount: documents.filter((document) => document.sourceKind === 'official-curriculum').length,
    needsOcrCount: needsOcrDocuments.length,
    zeroChunkPdfCount: zeroChunkPdfs.length,
    zeroChunkCanonicalPdfCount: zeroChunkCanonicalPdfs.length,
    staleDocumentCount: freshness.staleDocumentIds.length,
    staleRunCount: freshness.staleRunIds.length,
    orphanedChunkCount: orphanedChunks.length,
    orphanedIndexChunkCount: orphanedIndexChunkIds.length,
    orphanedLinkCount: orphanedLinks.length,
    latestImportAt: freshness.latestImportAt,
    latestRunCompletedAt: freshness.latestRunCompletedAt,
    staleAfterDays,
    issues,
  };
}

export async function deleteCfaSourceDocument(documentId: string) {
  await db.transaction(
    'rw',
    [db.sourceDocuments, db.sourceChunks, db.sourceIndexes, db.sourceLinks, db.sourceLinkOverrides],
    async () => {
      await db.sourceDocuments.delete(documentId);
      const chunkIds = (await db.sourceChunks.where('documentId').equals(documentId).primaryKeys()) as string[];
      await db.sourceChunks.bulkDelete(chunkIds);
      const links = await db.sourceLinks.where('documentId').equals(documentId).toArray();
      await db.sourceLinks.bulkDelete(links.map((link) => link.id));
      const overrides = await db.sourceLinkOverrides.toArray();
      await db.sourceLinkOverrides.bulkDelete(
        overrides.filter((override) => chunkIds.includes(override.chunkId)).map((override) => override.id),
      );
      const remainingChunks = await decryptSourceChunksForRead(await db.sourceChunks.toArray());
      await db.sourceIndexes.clear();
      await db.sourceIndexes.bulkPut(buildCfaSourceIndexRows(remainingChunks));
    },
  );
}

export async function deleteAllCfaSourceVault() {
  await db.transaction(
    'rw',
    [
      db.sourceDocuments,
      db.sourceChunks,
      db.sourceIndexes,
      db.sourceIngestionRuns,
      db.sourceLinks,
      db.sourceLinkOverrides,
    ],
    async () => {
      await Promise.all([
        db.sourceDocuments.clear(),
        db.sourceChunks.clear(),
        db.sourceIndexes.clear(),
        db.sourceIngestionRuns.clear(),
        db.sourceLinks.clear(),
        db.sourceLinkOverrides.clear(),
      ]);
    },
  );
}
