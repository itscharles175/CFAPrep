import { afterEach, describe, expect, it } from 'vitest';
import { classifyPath, extractStructure, ingestTextSource, isTauri, pageChunksFromPages } from './desktopIngestion';
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
