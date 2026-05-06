import { beforeEach, describe, expect, it } from 'vitest';
import { exportVaultData, importVaultData, resetVaultData } from './progressStore';
import {
  buildCfaSourceBundle,
  buildCfaSourceTarget,
  buildCfaSourceIndexRows,
  clearCfaSourceLinkOverride,
  deleteAllCfaSourceVault,
  deleteCfaSourceDocument,
  exportCfaSourceBundle,
  getCfaSourceCoverageMap,
  getCfaSourceDocuments,
  getCfaSourceFreshnessDiagnostics,
  getCfaSourceHealthReport,
  getCfaSourceMapStatus,
  getCfaSourceSnippetsForTarget,
  importCfaSourceBundle,
  rebuildCfaSourceLinksForTarget,
  searchCfaSourceVault,
  setCfaSourceLinkOverride,
  validateCfaSourceBundle,
} from './cfaSourceVault';
import type { CfaSourceChunk, CfaSourceDocument } from './cfaSourceTypes';

const importedAt = '2026-05-06T12:00:00.000Z';

function documentRow(overrides: Partial<CfaSourceDocument> = {}): CfaSourceDocument {
  return {
    id: 'source:test-doc',
    title: 'Synthetic Level I Fixed Income Notes',
    level: 'level1',
    year: 2026,
    publisher: 'Synthetic Fixture',
    sourceKind: 'user-source',
    format: 'epub',
    sha256: 'hash-test-doc',
    logicalHash: 'logical-test-doc',
    sizeBytes: 512,
    canonical: true,
    coverageTags: ['level1', 'fixed-income'],
    topicIds: ['fixed-income'],
    chunkCount: 1,
    importedAt,
    privateUseOnly: true,
    ...overrides,
  };
}

function chunkRow(overrides: Partial<CfaSourceChunk> = {}): CfaSourceChunk {
  return {
    id: 'source:test-doc:chunk:0001',
    documentId: 'source:test-doc',
    chunkIndex: 0,
    locator: 'chapter 1',
    heading: 'Duration',
    text: 'Synthetic fixed income duration convexity and yield material for private local search.',
    normalizedText: 'synthetic fixed income duration convexity and yield material for private local search',
    topicIds: ['fixed-income'],
    sourceHash: 'hash-test-doc',
    importedAt,
    ...overrides,
  };
}

describe('CFA source vault', () => {
  beforeEach(async () => {
    await resetVaultData('full');
  });

  it('imports private .qvsource bundles, indexes chunks, and searches locally', async () => {
    const bundle = buildCfaSourceBundle({
      documents: [documentRow()],
      chunks: [chunkRow()],
      indexes: buildCfaSourceIndexRows([chunkRow()], importedAt),
      createdAt: importedAt,
    });

    expect(validateCfaSourceBundle(bundle).valid).toBe(true);
    await importCfaSourceBundle(bundle);

    const documents = await getCfaSourceDocuments();
    const results = await searchCfaSourceVault('duration yield');

    expect(documents).toHaveLength(1);
    expect(results[0]).toMatchObject({
      document: { id: 'source:test-doc' },
      chunk: { id: 'source:test-doc:chunk:0001' },
    });
    expect(results[0].score).toBeGreaterThan(2);
  });

  it('excludes source text from standard vault exports unless explicitly requested', async () => {
    await importCfaSourceBundle(buildCfaSourceBundle({ documents: [documentRow()], chunks: [chunkRow()] }));
    await rebuildCfaSourceLinksForTarget(
      buildCfaSourceTarget({
        kind: 'module',
        level: 'level1',
        topicId: 'fixed-income',
        title: 'Fixed income duration',
      }),
    );
    await setCfaSourceLinkOverride(
      'source-target:module:local:level1:fixed-income:fixed-income-duration',
      'source:test-doc:chunk:0001',
      'pin',
    );

    const standardExport = await exportVaultData();
    const sourceExport = await exportVaultData({ includeSourceVault: true });

    expect(standardExport.sourceVault).toBeUndefined();
    expect(sourceExport.sourceVault?.sourceChunks[0].text).toContain('Synthetic fixed income');
    expect(sourceExport.sourceVault?.sourceLinks?.length).toBeGreaterThan(0);
    expect(sourceExport.sourceVault?.sourceLinkOverrides?.[0].action).toBe('pin');

    await resetVaultData('full');
    await importVaultData(sourceExport, { mode: 'replace' });
    expect(await getCfaSourceDocuments()).toHaveLength(0);

    await importVaultData(sourceExport, { mode: 'replace', includeSourceVault: true });
    expect(await getCfaSourceDocuments()).toHaveLength(1);
  });

  it('reports coverage and supports clean source deletion', async () => {
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [
          documentRow(),
          documentRow({
            id: 'source:l3-doc',
            level: 'level3',
            title: 'Synthetic Private Wealth Pathway',
            sha256: 'hash-l3',
            topicIds: ['private-wealth-pathway'],
            chunkCount: 0,
          }),
        ],
        chunks: [chunkRow()],
      }),
    );

    const coverage = await getCfaSourceCoverageMap();
    expect(coverage.documentCount).toBe(2);
    expect(coverage.levelCounts.level1).toBe(1);
    expect(coverage.topicCounts['private-wealth-pathway']).toBe(1);

    await deleteCfaSourceDocument('source:test-doc');
    expect(await searchCfaSourceVault('duration')).toHaveLength(0);

    const bundle = await exportCfaSourceBundle();
    expect(bundle.documents.map((document) => document.id)).toEqual(['source:l3-doc']);

    await deleteAllCfaSourceVault();
    expect(await getCfaSourceDocuments()).toHaveLength(0);
  });

  it('reports source health counts for searchable and OCR-blocked documents', async () => {
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [
          documentRow(),
          documentRow({
            id: 'source:scan-pdf',
            title: 'Synthetic Scanned Curriculum PDF',
            publisher: 'CFA Institute',
            sourceKind: 'official-curriculum',
            format: 'pdf',
            sha256: 'hash-scan-pdf',
            logicalHash: undefined,
            pageCount: 12,
            textOperatorCount: 0,
            extractableTextChars: 0,
            chunkCount: 0,
            needsOcr: true,
          }),
        ],
        chunks: [chunkRow()],
      }),
    );

    const health = await getCfaSourceHealthReport({ asOf: new Date('2026-05-06T12:00:00.000Z'), staleAfterDays: 30 });
    expect(health).toMatchObject({
      status: 'blocked',
      documentCount: 2,
      chunkCount: 1,
      searchableDocumentCount: 1,
      needsOcrCount: 1,
      zeroChunkPdfCount: 1,
      zeroChunkCanonicalPdfCount: 1,
    });
    expect(health.issues.map((issue) => issue.code)).toContain('zero-chunk-canonical-pdf');
    expect(health.issues.map((issue) => issue.code)).toContain('needs-ocr');
  });

  it('reports stale source freshness diagnostics deterministically', async () => {
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [documentRow({ importedAt: '2026-01-01T00:00:00.000Z' })],
        chunks: [chunkRow({ importedAt: '2026-01-01T00:00:00.000Z' })],
        runs: [
          {
            id: 'source-run:old',
            rootPath: '<private-local-source-root>',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:01:00.000Z',
            status: 'completed',
            documentCount: 1,
            chunkCount: 1,
            bytesScanned: 512,
            warnings: [],
            errors: [],
            policy: {
              privateUseOnly: true,
              allowStandardExport: false,
              textStorage: 'qvsource-bundle',
              notes: 'fixture',
            },
          },
        ],
      }),
    );

    const freshness = await getCfaSourceFreshnessDiagnostics({
      asOf: new Date('2026-05-06T12:00:00.000Z'),
      staleAfterDays: 30,
    });
    const health = await getCfaSourceHealthReport({ asOf: new Date('2026-05-06T12:00:00.000Z'), staleAfterDays: 30 });

    expect(freshness.stale).toBe(true);
    expect(freshness.staleDocumentIds).toEqual(['source:test-doc']);
    expect(freshness.staleRunIds).toEqual(['source-run:old']);
    expect(health.status).toBe('warning');
    expect(health.staleDocumentCount).toBe(1);
    expect(health.staleRunCount).toBe(1);
  });

  it('replaces stale private source rows, links, indexes, and overrides by default', async () => {
    const target = buildCfaSourceTarget({
      kind: 'module',
      level: 'level1',
      topicId: 'fixed-income',
      title: 'Duration source map',
    });
    await importCfaSourceBundle(buildCfaSourceBundle({ documents: [documentRow()], chunks: [chunkRow()] }));
    await rebuildCfaSourceLinksForTarget(target);
    await setCfaSourceLinkOverride(target.id, 'source:test-doc:chunk:0001', 'dismiss');

    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [
          documentRow({
            id: 'source:new-doc',
            title: 'Synthetic Equity Notes',
            sha256: 'hash-new-doc',
            topicIds: ['equity'],
            chunkCount: 1,
          }),
        ],
        chunks: [
          chunkRow({
            id: 'source:new-doc:chunk:0001',
            documentId: 'source:new-doc',
            sourceHash: 'hash-new-doc',
            text: 'Equity valuation residual income market multiple material for private local search.',
            normalizedText: 'equity valuation residual income market multiple material for private local search',
            topicIds: ['equity'],
          }),
        ],
      }),
    );

    expect((await getCfaSourceDocuments()).map((document) => document.id)).toEqual(['source:new-doc']);
    expect(await searchCfaSourceVault('duration')).toHaveLength(0);
    expect(await searchCfaSourceVault('residual income')).toHaveLength(1);
    expect(await getCfaSourceSnippetsForTarget(target)).toHaveLength(0);
    expect((await getCfaSourceMapStatus()).overrideCount).toBe(0);
  });

  it('falls back to chunk scanning when source token indexes are stale', async () => {
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [documentRow()],
        chunks: [chunkRow()],
        indexes: [
          {
            id: 'token:unrelated',
            token: 'unrelated',
            documentIds: ['source:test-doc'],
            chunkIds: ['source:test-doc:chunk:0001'],
            updatedAt: importedAt,
          },
        ],
      }),
    );

    const results = await searchCfaSourceVault('duration yield');
    expect(results).toHaveLength(1);
    expect(results[0].chunk.id).toBe('source:test-doc:chunk:0001');
  });

  it('maps targets to official-first snippets with diversity and short previews', async () => {
    const target = buildCfaSourceTarget({
      kind: 'objective',
      domain: 'cfa',
      level: 'level1',
      topicId: 'fixed-income',
      title: 'Duration and convexity risk',
      objectiveIds: ['fi-duration'],
      keywords: ['yield', 'convexity'],
    });
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [
          documentRow({
            id: 'source:official',
            publisher: 'CFA Institute',
            sourceKind: 'official-curriculum',
            sha256: 'hash-official',
          }),
          documentRow({ id: 'source:prep', publisher: 'Schweser', sourceKind: 'prep-provider', sha256: 'hash-prep' }),
        ],
        chunks: [
          chunkRow({
            id: 'source:prep:chunk:0001',
            documentId: 'source:prep',
            sourceHash: 'hash-prep',
            text: 'Duration convexity yield risk '.repeat(40),
            normalizedText: 'duration convexity yield risk '.repeat(40),
          }),
          chunkRow({
            id: 'source:official:chunk:0001',
            documentId: 'source:official',
            sourceHash: 'hash-official',
            text: 'Official curriculum duration convexity yield risk for fixed income '.repeat(40),
            normalizedText: 'official curriculum duration convexity yield risk for fixed income '.repeat(40),
          }),
        ],
      }),
    );

    const links = await rebuildCfaSourceLinksForTarget(target, 4);
    const snippets = await getCfaSourceSnippetsForTarget(target, 4);

    expect(links[0]).toMatchObject({ documentId: 'source:official', sourcePriority: 'official-canonical' });
    expect(snippets[0].preview.length).toBeLessThanOrEqual(363);
    expect(new Set(snippets.map((snippet) => snippet.document.id)).size).toBeGreaterThan(1);
  });

  it('honors pin and dismiss overrides and cascades deleted links', async () => {
    const target = buildCfaSourceTarget({
      kind: 'module',
      level: 'level3',
      topicId: 'private-wealth-pathway',
      pathway: 'private-wealth',
      title: 'Private wealth pathway',
    });
    await importCfaSourceBundle(
      buildCfaSourceBundle({
        documents: [
          documentRow({
            id: 'source:official',
            level: 'level3',
            publisher: 'CFA Institute',
            sourceKind: 'official-curriculum',
            sha256: 'hash-official',
            topicIds: ['portfolio'],
          }),
          documentRow({
            id: 'source:wealth',
            level: 'level3',
            publisher: 'Schweser',
            sourceKind: 'prep-provider',
            sha256: 'hash-wealth',
            topicIds: ['private-wealth-pathway'],
          }),
        ],
        chunks: [
          chunkRow({
            id: 'source:official:chunk:0001',
            documentId: 'source:official',
            sourceHash: 'hash-official',
            topicIds: ['portfolio'],
            text: 'Portfolio management pathway context',
            normalizedText: 'portfolio management pathway context',
          }),
          chunkRow({
            id: 'source:wealth:chunk:0001',
            documentId: 'source:wealth',
            sourceHash: 'hash-wealth',
            topicIds: ['private-wealth-pathway'],
            text: 'Private wealth family tax philanthropy pathway context',
            normalizedText: 'private wealth family tax philanthropy pathway context',
          }),
        ],
      }),
    );

    await rebuildCfaSourceLinksForTarget(target, 4);
    await setCfaSourceLinkOverride(target.id, 'source:wealth:chunk:0001', 'pin');
    await setCfaSourceLinkOverride(target.id, 'source:official:chunk:0001', 'dismiss');
    let snippets = await getCfaSourceSnippetsForTarget(target, 4);
    expect(snippets[0]).toMatchObject({ pinned: true, chunk: { id: 'source:wealth:chunk:0001' } });
    expect(snippets.map((snippet) => snippet.chunk.id)).not.toContain('source:official:chunk:0001');

    await clearCfaSourceLinkOverride(target.id, 'source:official:chunk:0001');
    await deleteCfaSourceDocument('source:wealth');
    snippets = await getCfaSourceSnippetsForTarget(target, 4);
    const status = await getCfaSourceMapStatus();
    expect(snippets.map((snippet) => snippet.document.id)).not.toContain('source:wealth');
    expect(status.linkCount).toBeGreaterThanOrEqual(0);
  });

  it('keeps Level III source targets distinct by selected pathway', async () => {
    const pmTarget = buildCfaSourceTarget({ kind: 'module', level: 'level3', topicId: 'portfolio-construction', pathway: 'portfolio-management', title: 'Portfolio construction' });
    const wealthTarget = buildCfaSourceTarget({ kind: 'module', level: 'level3', topicId: 'portfolio-construction', pathway: 'private-wealth', title: 'Portfolio construction' });

    expect(pmTarget.id).toContain(':portfolio-management:');
    expect(wealthTarget.id).toContain(':private-wealth:');
    expect(pmTarget.id).not.toBe(wealthTarget.id);
  });

  it('rejects bundles that are not marked private-use', () => {
    const invalid = buildCfaSourceBundle({ documents: [documentRow()], chunks: [chunkRow()] });
    invalid.documents[0].privateUseOnly = false as true;

    const validation = validateCfaSourceBundle(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes('privateUseOnly'))).toBe(true);
  });

  it('strips absolute local filesystem paths from portable source bundles', () => {
    const bundle = buildCfaSourceBundle({
      documents: [documentRow({ path: 'C:\\Users\\charl\\Downloads\\Compressed\\Level 1\\Volume 1.epub' })],
      chunks: [chunkRow()],
      runs: [
        {
          id: 'source-run:test',
          rootPath: 'C:\\Users\\charl\\Downloads\\Compressed',
          startedAt: importedAt,
          completedAt: importedAt,
          status: 'completed',
          documentCount: 1,
          chunkCount: 1,
          bytesScanned: 512,
          warnings: [],
          errors: [],
          policy: {
            privateUseOnly: true,
            allowStandardExport: false,
            textStorage: 'qvsource-bundle',
            notes: 'fixture',
          },
        },
      ],
    });

    expect(JSON.stringify(bundle)).not.toContain('C:\\Users\\charl');
    expect(bundle.runs?.[0].rootPath).toBe('<private-local-source-root>');
  });

  it('strips unsafe archive paths from portable source bundles', () => {
    const bundle = buildCfaSourceBundle({
      documents: [
        documentRow({
          path: 'D:\\Private\\CFA\\Level 1\\Volume 1.pdf',
          archivePath: 'D:\\Private\\CFA\\source.zip',
          archiveMemberPath: '../Volume 1.pdf',
        }),
      ],
      chunks: [chunkRow()],
    });

    expect(JSON.stringify(bundle)).not.toContain('D:\\Private');
    expect(bundle.documents[0].path).toBeUndefined();
    expect(bundle.documents[0].archivePath).toBeUndefined();
    expect(bundle.documents[0].archiveMemberPath).toBeUndefined();
  });
});
