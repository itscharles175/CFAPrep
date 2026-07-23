import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPath,
  extractStructure,
  ingestTextSource,
  isElectron,
  listFolderPdfs,
  onElectronPdfDrop,
  pageChunksFromPages,
  pickCfaFolder,
  readPdfBytes,
} from './desktopIngestion';
import { registerDesktopSubscription, type DesktopUnsubscribe, type StudyVaultBridge } from './desktopBridge';
import { db } from './progressStore';

function createBridge(
  overrides: {
    files?: Partial<StudyVaultBridge['files']>;
    events?: Partial<StudyVaultBridge['events']>;
  } = {},
): StudyVaultBridge {
  const unsubscribe = () => undefined;
  return {
    runtime: {
      info: async () => ({
        app_version: 'test',
        electron_version: 'test',
        chrome_version: 'test',
        node_version: 'test',
        platform: 'win32',
        arch: 'x64',
        is_packaged: false,
      }),
    },
    files: {
      pickFolder: async () => null,
      pickFiles: async () => [],
      listPdfs: async () => [],
      read: async (path) => ({ path, name: 'file.pdf', extension: '.pdf', size: 0, data: new Uint8Array() }),
      ...overrides.files,
    },
    sidecar: {
      status: async () => [],
      logs: async () => [],
      aggregate: async () => ({
        status: 'ok',
        ready: 0,
        required_down: 0,
        optional_down: 0,
        total: 0,
        required_down_names: [],
      }),
    },
    keychain: {
      get: async () => null,
      set: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    openPath: async () => ({ opened: true, error: '' }),
    openExternal: async () => ({ opened: true }),
    popout: async () => ({ id: 1 }),
    notification: async () => ({ shown: true }),
    fullscreen: {
      get: async () => false,
      set: async (value) => value,
    },
    events: {
      onBootStatus: () => unsubscribe,
      onSecondInstance: () => unsubscribe,
      onOpenFile: () => unsubscribe,
      onPdfDrop: () => unsubscribe,
      ...overrides.events,
    },
  };
}

afterEach(() => {
  delete window.studyvault;
  vi.restoreAllMocks();
});

describe('desktopIngestion (pure helpers)', () => {
  it('reports whether the Electron bridge is available', () => {
    expect(isElectron()).toBe(false);
  });

  it('detects and routes native file operations through the Electron bridge', async () => {
    const wireEntries = [
      {
        path: 'C:\\CFA\\book.pdf',
        name: 'book.pdf',
        extension: '.pdf' as const,
        size: 42,
        relative_path: 'book.pdf',
      },
    ];
    const entries = [{ path: 'C:\\CFA\\book.pdf', name: 'book.pdf', size: 42, relative: 'book.pdf' }];
    const pickFolder = vi.fn(async () => 'C:\\CFA');
    const listPdfs = vi.fn(async () => wireEntries);
    const read = vi.fn(async (path: string) => ({
      path,
      name: 'book.pdf',
      extension: '.pdf' as const,
      size: 3,
      data: new Uint8Array([1, 2, 255]),
    }));
    window.studyvault = createBridge({ files: { pickFolder, listPdfs, read } });

    expect(isElectron()).toBe(true);
    await expect(pickCfaFolder()).resolves.toBe('C:\\CFA');
    await expect(listFolderPdfs('C:\\CFA')).resolves.toEqual(entries);
    await expect(readPdfBytes('C:\\CFA\\book.pdf')).resolves.toEqual(new Uint8Array([1, 2, 255]));
    expect(listPdfs).toHaveBeenCalledWith('C:\\CFA');
    expect(read).toHaveBeenCalledWith('C:\\CFA\\book.pdf');
  });

  it('returns drag-drop cleanup synchronously and preserves the current caller contract', async () => {
    let dropHandler!: (event: { paths: string[] }) => void;
    const nativeUnsubscribe = vi.fn();
    const onPdfDrop = vi.fn((handler: (event: { paths: string[] }) => void) => {
      dropHandler = handler;
      return nativeUnsubscribe;
    });
    window.studyvault = createBridge({ events: { onPdfDrop } });
    const received = vi.fn();

    const unsubscribe = onElectronPdfDrop(received);

    expect(typeof unsubscribe).toBe('function');
    dropHandler({ paths: ['first.pdf', 'notes.txt', 'SECOND.PDF'] });
    expect(received).toHaveBeenCalledWith(['first.pdf', 'SECOND.PDF']);

    unsubscribe();
    expect(nativeUnsubscribe).toHaveBeenCalledTimes(1);

    let compatibilityCleanup: DesktopUnsubscribe | null = null;
    await unsubscribe.then((registered) => {
      compatibilityCleanup = registered;
    });
    expect(compatibilityCleanup).toBe(unsubscribe);
  });

  it('closes a subscription that resolves after synchronous cleanup', async () => {
    let resolveRegistration!: (unsubscribe: DesktopUnsubscribe) => void;
    const nativeUnsubscribe = vi.fn();
    const unsubscribe = registerDesktopSubscription(
      () =>
        new Promise<DesktopUnsubscribe>((resolve) => {
          resolveRegistration = resolve;
        }),
    );

    unsubscribe();
    resolveRegistration(nativeUnsubscribe);

    await vi.waitFor(() => expect(nativeUnsubscribe).toHaveBeenCalledTimes(1));
  });

  it('classifies an official Level I PDF path', () => {
    const c = classifyPath('CFA Level 1/Official Curriculum/Volume 4 Fixed Income.pdf');
    expect(c.level).toBe('level1');
    expect(c.sourceKind).toBe('official-curriculum');
    expect(c.publisher).toBe('CFA Institute');
    expect(c.topicIds).toContain('fixed-income');
  });

  it('classifies a Level II Schweser prep PDF', () => {
    const c = classifyPath('Level 2/Schweser/Notes - Equity Valuation.pdf');
    expect(c.level).toBe('level2');
    expect(c.sourceKind).toBe('prep-provider');
    expect(c.publisher).toBe('Schweser');
    expect(c.topicIds).toContain('equity');
  });

  it('classifies a generic user PDF as "unknown" level / user-source', () => {
    const c = classifyPath('my-notes/something else.pdf');
    expect(c.level).toBe('unknown');
    expect(c.sourceKind).toBe('user-source');
    expect(c.publisher).toBe('User Source');
  });

  it('matches multiple topic rules where the title overlaps', () => {
    const c = classifyPath('CFA Level 3/Portfolio Management - Fixed Income tilt.pdf');
    expect(c.topicIds).toEqual(expect.arrayContaining(['portfolio', 'fixed-income']));
  });

  it('chunks pages into overlapping word windows with page-range locators', () => {
    const pages = [
      { pageNumber: 263, text: 'A '.repeat(300).trim() + ' duration begins here' },
      { pageNumber: 264, text: 'B '.repeat(400).trim() + ' modified duration continues' },
      { pageNumber: 265, text: 'C '.repeat(200).trim() },
    ];
    const chunks = pageChunksFromPages(pages, 'desktop:abc', 'hash:abc', ['fixed-income'], '2026-05-27T00:00:00Z');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.documentId).toBe('desktop:abc');
      expect(chunk.sourceHash).toBe('hash:abc');
      expect(chunk.topicIds).toEqual(['fixed-income']);
      expect(chunk.locator).toMatch(/^p\. \d+(?:-\d+)?$/);
      expect(chunk.normalizedText.length).toBeGreaterThanOrEqual(80);
    }
    // First chunk starts on page 263; later chunks should reach page 264+.
    expect(chunks[0].locator).toContain('263');
    expect(chunks.some((c) => /264|265/.test(c.locator))).toBe(true);
  });

  it('populates learningOutcomes on a chunk whose page text contains LOS', () => {
    const losBlock =
      'LEARNING OUTCOMES The candidate should be able to: a. calculate the value of a bond; ' +
      'b. describe the term structure; c. compare credit spreads across issuers. ';
    const pages = [{ pageNumber: 12, text: losBlock + 'filler '.repeat(120) }];
    const chunks = pageChunksFromPages(pages, 'desktop:los', 'hash:los', ['fixed-income'], '2026-05-27T00:00:00Z');
    expect(chunks.length).toBeGreaterThan(0);
    const tagged = chunks.find((chunk) => (chunk.learningOutcomes?.length ?? 0) > 0);
    expect(tagged).toBeDefined();
    expect(tagged?.learningOutcomes).toEqual(
      expect.arrayContaining(['calculate the value of a bond', 'describe the term structure']),
    );
    expect(tagged?.losVerbs).toEqual(expect.arrayContaining(['calculate', 'describe', 'compare']));
  });

  it('drops chunks that fail the normalized-length floor (mostly punctuation)', () => {
    const pages = [{ pageNumber: 1, text: '!!! --- ... ??? !!!' }];
    const chunks = pageChunksFromPages(pages, 'd', 'h', [], '2026-05-27T00:00:00Z');
    expect(chunks).toHaveLength(0);
  });

  describe('extractStructure (LOS + heading)', () => {
    it('pulls 3 LOS from a "candidate should be able to" lettered block', () => {
      const s = extractStructure('The candidate should be able to: a. calculate X; b. describe Y; c. compare Z');
      expect(s.learningOutcomes).toEqual(['calculate X', 'describe Y', 'compare Z']);
    });

    it('returns the opening verbs (deduplicated, lowercased) for that block', () => {
      const s = extractStructure('The candidate should be able to: a. calculate X; b. describe Y; c. compare Z');
      expect(s.losVerbs).toEqual(['calculate', 'describe', 'compare']);
    });

    it('returns an empty learningOutcomes array for plain prose with no LOS', () => {
      const s = extractStructure(
        'Modified duration estimates a bond price change for a small shift in yield. This is ordinary prose about fixed income.',
      );
      expect(s.learningOutcomes).toEqual([]);
      expect(s.losVerbs).toEqual([]);
    });

    it('detects a bulleted LOS list introduced by "Learning Outcomes"', () => {
      const s = extractStructure('Learning Outcomes • evaluate the credit risk • identify the spread duration');
      expect(s.learningOutcomes).toContain('evaluate the credit risk');
      expect(s.losVerbs).toContain('evaluate');
    });

    it('caps the LOS list at 20', () => {
      let text = 'The candidate should be able to: ';
      for (let i = 0; i < 30; i += 1) {
        text += `${String.fromCharCode(97 + (i % 26))}. calculate item number ${i}; `;
      }
      const s = extractStructure(text);
      expect(s.learningOutcomes).toHaveLength(20);
    });

    it('still extracts a "LEARNING MODULE 5: Fixed Income" heading', () => {
      const s = extractStructure('LEARNING MODULE 5: Fixed Income duration and convexity discussion follows.');
      expect(s.heading).toContain('LEARNING MODULE 5');
      expect(s.heading).toContain('Fixed Income');
    });

    it('catches a "STUDY SESSION 3" heading but not the word "reading" mid-prose', () => {
      const session = extractStructure('STUDY SESSION 3 introduces the topics for this level.');
      expect(session.heading).toContain('STUDY SESSION 3');

      const prose = extractStructure('The candidate enjoyed reading the chapter on the topic of bond pricing.');
      expect(prose.heading).toBeUndefined();
    });
  });

  describe('ingestTextSource', () => {
    afterEach(async () => {
      await db.sourceDocuments.clear();
      await db.sourceChunks.clear();
    });

    it('persists a document + chunks for a pasted text source and dedupes on re-ingest', async () => {
      const text = `Modified duration estimates a bond's percentage price change for a 1pp shift in yield. `.repeat(20);
      const first = await ingestTextSource({
        title: 'Modified Duration notes',
        text,
        topicIds: ['fixed-income'],
        level: 'level1',
        publisher: 'Lecture notes',
      });
      expect(first.deduped).toBe(false);
      expect(first.chunkCount).toBeGreaterThan(0);
      expect(first.documentId.startsWith('paste:')).toBe(true);

      const doc = await db.sourceDocuments.get(first.documentId);
      expect(doc).toBeDefined();
      expect(doc?.title).toBe('Modified Duration notes');
      expect(doc?.sourceKind).toBe('user-source');
      expect(doc?.format).toBe('text');
      expect(doc?.topicIds).toEqual(['fixed-income']);
      const chunks = await db.sourceChunks.where('documentId').equals(first.documentId).toArray();
      expect(chunks.length).toBe(first.chunkCount);
      expect(chunks[0].locator).toMatch(/^p\. 1$/);

      // Same text → dedupes (same documentId, no new write).
      const second = await ingestTextSource({ title: 'Different title same text', text });
      expect(second.deduped).toBe(true);
      expect(second.documentId).toBe(first.documentId);
      const docs = await db.sourceDocuments.toArray();
      expect(docs).toHaveLength(1);
    });

    it('rejects empty text', async () => {
      await expect(ingestTextSource({ title: 'x', text: '   ' })).rejects.toThrow(/empty/);
    });
  });
});
