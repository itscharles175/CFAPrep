import { afterEach, describe, expect, it } from 'vitest';
import { classifyPath, ingestTextSource, isTauri, pageChunksFromPages } from './desktopIngestion';
import { db } from './progressStore';

describe('desktopIngestion (pure helpers)', () => {
  it('isTauri returns false in plain browser / jsdom test env', () => {
    expect(isTauri()).toBe(false);
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

  it('drops chunks that fail the normalized-length floor (mostly punctuation)', () => {
    const pages = [{ pageNumber: 1, text: '!!! --- ... ??? !!!' }];
    const chunks = pageChunksFromPages(pages, 'd', 'h', [], '2026-05-27T00:00:00Z');
    expect(chunks).toHaveLength(0);
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
