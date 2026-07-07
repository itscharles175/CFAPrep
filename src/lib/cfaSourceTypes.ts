export type CfaSourceFormat = 'pdf' | 'epub' | 'html' | 'xml' | 'archive' | 'text' | 'unknown';

export type CfaSourceLevel = 'level1' | 'level2' | 'level3' | 'prerequisite' | 'reference' | 'unknown';

export type CfaSourcePolicy = {
  privateUseOnly: true;
  allowStandardExport: false;
  textStorage: 'indexeddb' | 'qvsource-bundle' | 'local-app-data';
  notes: string;
};

export type CfaSourceDocument = {
  id: string;
  title: string;
  level: CfaSourceLevel;
  year?: number;
  publisher: string;
  sourceKind: 'official-curriculum' | 'prep-provider' | 'reference-book' | 'archive-metadata' | 'user-source';
  format: CfaSourceFormat;
  path?: string;
  archivePath?: string;
  archiveMemberPath?: string;
  sha256: string;
  logicalHash?: string;
  sizeBytes: number;
  pageCount?: number;
  textOperatorCount?: number;
  extractableTextChars?: number;
  spineCount?: number;
  canonical: boolean;
  duplicateOf?: string;
  needsOcr?: boolean;
  coverageTags: string[];
  topicIds: string[];
  chunkCount: number;
  importedAt: string;
  privateUseOnly: true;
};

export type CfaSourceChunk = {
  id: string;
  documentId: string;
  chunkIndex: number;
  locator: string;
  heading?: string;
  text: string;
  normalizedText: string;
  topicIds: string[];
  sourceHash: string;
  importedAt: string;
  /** Individual Learning Outcome Statements detected in this chunk (CFA curriculum). */
  learningOutcomes?: string[];
  /** Lowercased, deduplicated action verbs that opened each detected LOS. */
  losVerbs?: string[];
  secureVault?: {
    v: 1;
    scheme: 'secure-vault-source-chunk.v1';
    text: { v: 1; iv: string; ct: string };
    normalizedText?: { v: 1; iv: string; ct: string };
    heading?: { v: 1; iv: string; ct: string };
    learningOutcomes?: { v: 1; iv: string; ct: string };
  };
};

export type CfaSourceIndex = {
  id: string;
  token: string;
  documentIds: string[];
  chunkIds: string[];
  updatedAt: string;
};

export type CfaSourceIngestionRun = {
  id: string;
  rootPath: string;
  startedAt: string;
  completedAt?: string;
  status: 'completed' | 'partial' | 'failed';
  documentCount: number;
  chunkCount: number;
  bytesScanned: number;
  warnings: string[];
  errors: string[];
  policy: CfaSourcePolicy;
};

export type CfaSourceCoverageMap = {
  generatedAt: string;
  documentCount: number;
  chunkCount: number;
  levelCounts: Record<CfaSourceLevel, number>;
  topicCounts: Record<string, number>;
  documents: Array<{
    id: string;
    title: string;
    level: CfaSourceLevel;
    year?: number;
    publisher: string;
    topicIds: string[];
    chunkCount: number;
    needsOcr?: boolean;
  }>;
};

export type CfaSourceVaultStores = {
  sourceDocuments: CfaSourceDocument[];
  sourceChunks: CfaSourceChunk[];
  sourceIndexes: CfaSourceIndex[];
  sourceIngestionRuns: CfaSourceIngestionRun[];
  sourceLinks?: CfaSourceLink[];
  sourceLinkOverrides?: CfaSourceLinkOverride[];
};

export type CfaSourceBundle = {
  app: 'QuantVault';
  kind: 'cfa-source-vault';
  bundleVersion: 1;
  createdAt: string;
  policy: CfaSourcePolicy;
  documents: CfaSourceDocument[];
  chunks: CfaSourceChunk[];
  indexes?: CfaSourceIndex[];
  runs?: CfaSourceIngestionRun[];
};

export type CfaSourceSearchResult = {
  document: CfaSourceDocument;
  chunk: CfaSourceChunk;
  score: number;
  preview: string;
};

export type CfaSourceTargetKind =
  | 'module'
  | 'objective'
  | 'section'
  | 'formula'
  | 'question'
  | 'vignette'
  | 'constructed-response'
  | 'mock'
  | 'review-item'
  | 'tool'
  | 'global-search';

export type CfaSourceTarget = {
  id: string;
  kind: CfaSourceTargetKind;
  title: string;
  domain?: string;
  level?: CfaSourceLevel;
  topicId?: string;
  pathway?: 'core' | 'portfolio-management' | 'private-markets' | 'private-wealth';
  objectiveIds?: string[];
  formulaNames?: string[];
  keywords?: string[];
  route?: string;
};

export type CfaSourcePriority =
  | 'official-canonical'
  | 'official-mirror'
  | 'prep-provider'
  | 'reference'
  | 'user-source';

export type CfaSourceLink = {
  id: string;
  targetId: string;
  targetKind: CfaSourceTargetKind;
  documentId: string;
  chunkId: string;
  score: number;
  rank: number;
  sourcePriority: CfaSourcePriority;
  matchedTerms: string[];
  rankReason: string;
  createdAt: string;
};

export type CfaSourceLinkOverride = {
  id: string;
  targetId: string;
  chunkId: string;
  action: 'pin' | 'dismiss';
  updatedAt: string;
};

export type CfaSourceSnippet = {
  targetId: string;
  link: CfaSourceLink;
  document: CfaSourceDocument;
  chunk: CfaSourceChunk;
  preview: string;
  pinned: boolean;
  dismissed: boolean;
};

export type CfaSourceMapStatus = {
  generatedAt: string;
  documentCount: number;
  chunkCount: number;
  linkCount: number;
  overrideCount: number;
  officialDocumentCount: number;
  targetCount: number;
};

export type CfaSourceHealthIssue = {
  code:
    | 'zero-chunk-canonical-pdf'
    | 'needs-ocr'
    | 'orphaned-chunk'
    | 'orphaned-index-chunk'
    | 'orphaned-link'
    | 'stale-source-document'
    | 'stale-ingestion-run';
  severity: 'info' | 'warning' | 'blocked';
  message: string;
  documentId?: string;
  runId?: string;
  count?: number;
};

export type CfaSourceHealthReport = {
  generatedAt: string;
  status: 'ok' | 'warning' | 'blocked';
  documentCount: number;
  chunkCount: number;
  indexCount: number;
  runCount: number;
  canonicalDocumentCount: number;
  searchableDocumentCount: number;
  searchableCanonicalDocumentCount: number;
  officialDocumentCount: number;
  needsOcrCount: number;
  zeroChunkPdfCount: number;
  zeroChunkCanonicalPdfCount: number;
  staleDocumentCount: number;
  staleRunCount: number;
  orphanedChunkCount: number;
  orphanedIndexChunkCount: number;
  orphanedLinkCount: number;
  latestImportAt?: string;
  latestRunCompletedAt?: string;
  staleAfterDays: number;
  issues: CfaSourceHealthIssue[];
};

export type CfaSourceFreshnessDiagnostics = {
  generatedAt: string;
  asOf: string;
  staleAfterDays: number;
  latestImportAt?: string;
  latestRunCompletedAt?: string;
  stale: boolean;
  staleDocumentIds: string[];
  staleRunIds: string[];
  diagnostics: CfaSourceHealthIssue[];
};
