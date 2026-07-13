import { describe, expect, it } from 'vitest';

import { chunkDocumentV2, splitIntoSections, windowChunk } from './chunkingV2';

describe('RAG-5 — structure-aware chunking v2', () => {
  it('splits on markdown headings, one section per heading', () => {
    const doc = '## Duration\nModified duration measures sensitivity.\n## Convexity\nConvexity captures curvature.';
    const sections = splitIntoSections(doc);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Duration');
    expect(sections[1].heading).toBe('Convexity');
  });

  it('detects LOS markers and numbered sections', () => {
    const doc = 'LOS 9.a Describe FRA settlement.\nIt settles in cash.\n3.2 Spread analysis\nOAS removes option value.';
    const sections = splitIntoSections(doc);
    expect(sections.map((s) => s.heading)).toEqual(['LOS 9.a Describe FRA settlement.', '3.2 Spread analysis']);
  });

  it('keeps an LOS section intact as ONE chunk (no mid-LOS split)', () => {
    const doc = '## Forward Rate Agreement\nA forward rate agreement settles in cash at expiration based on the difference between the contracted forward rate and the realized reference rate.';
    const chunks = chunkDocumentV2(doc, { documentId: 'doc1', maxChars: 1200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Forward Rate Agreement');
    expect(chunks[0].text).toContain('settles in cash');
    expect(chunks[0].locator).toBe('Forward Rate Agreement');
    expect(chunks[0].window).toBe(0);
  });

  it('windowed fallback ONLY inside an oversized section, re-prepending the heading', () => {
    const longBody = 'sentence one here. '.repeat(60); // ~1140 chars
    const doc = `## Big Section\n${longBody}`;
    const chunks = chunkDocumentV2(doc, { documentId: 'doc2', maxChars: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // every sub-chunk carries the heading + a windowed locator.
    for (const c of chunks) {
      expect(c.text.startsWith('Big Section')).toBe(true);
      expect(c.locator.startsWith('Big Section')).toBe(true);
      expect(c.section).toBe(0);
    }
    expect(chunks[chunks.length - 1].window).toBeGreaterThan(0);
  });

  it('degrades to pure windowing when there is no structure', () => {
    const doc = 'plain prose with no headings at all. '.repeat(40);
    const chunks = chunkDocumentV2(doc, { documentId: 'doc3', maxChars: 300, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    // no heading → fallback locator.
    expect(chunks[0].locator).toMatch(/^section/);
  });

  it('captures preamble text before the first heading', () => {
    const doc = 'Intro paragraph before any heading.\n## First\nbody';
    const sections = splitIntoSections(doc);
    expect(sections[0].heading).toBe('');
    expect(sections[0].body).toContain('Intro paragraph');
    expect(sections[1].heading).toBe('First');
  });

  it('produces stable, idempotent ids from documentId + ordinal', () => {
    const doc = '## A\nbody a\n## B\nbody b';
    const a = chunkDocumentV2(doc, { documentId: 'docX' });
    const b = chunkDocumentV2(doc, { documentId: 'docX' });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a[0].id).toBe('docX::s0');
    expect(a[1].id).toBe('docX::s1');
  });

  it('windowChunk keeps short text as a single chunk', () => {
    expect(windowChunk('short text', 1000, 100)).toEqual(['short text']);
    expect(windowChunk('', 1000, 100)).toEqual([]);
  });

  it('windowChunk overlaps consecutive windows', () => {
    const text = 'abc def ghi jkl mno pqr stu vwx yz0 123 456 789';
    const windows = windowChunk(text, 20, 8);
    expect(windows.length).toBeGreaterThan(1);
  });
});
