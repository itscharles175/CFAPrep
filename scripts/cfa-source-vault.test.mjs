import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  extractEpubText,
  extractPdfText,
  pickCanonical,
  probePdfQuality,
  readZipEntries,
  sha256,
  textChunksFromText,
} from './cfa-source-vault.mjs';

function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(({ name, content }) => {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  });

  const centralOffset = offset;
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, end]);
}

describe('CFA source vault CLI helpers', () => {
  it('hashes source bytes and creates stable chunk identifiers', () => {
    const hash = sha256(Buffer.from('private source fixture'));
    const chunks = textChunksFromText(
      'Duration, Convexity & Yield Curve! '.repeat(45),
      'source:test',
      hash,
      ['portfolio-construction'],
      '2026-05-06T00:00:00.000Z',
    );

    expect(hash).toHaveLength(64);
    expect(chunks[0]).toMatchObject({
      id: 'source:test:chunk:0001',
      documentId: 'source:test',
      chunkIndex: 0,
      topicIds: ['portfolio-construction'],
      sourceHash: hash,
    });
    expect(chunks[0].text).toContain('Duration, Convexity & Yield Curve!');
    expect(chunks[0].normalizedText).toContain('duration convexity yield curve');
  });

  it('parses EPUB zip entries while rejecting traversal members', () => {
    const zip = buildStoredZip([
      { name: 'OPS/chapter.xhtml', content: '<html>Private wealth tax planning.</html>' },
      { name: '../escape.xhtml', content: '<html>should not be visible</html>' },
      { name: '/absolute.xhtml', content: '<html>should not be visible</html>' },
    ]);

    expect(readZipEntries(zip).map((entry) => entry.name)).toEqual(['OPS/chapter.xhtml']);
    expect(extractEpubText(zip)).toContain('Private wealth tax planning');
    expect(extractEpubText(zip)).not.toContain('should not be visible');
  });

  it('prefers EPUB over PDF and dedupes volume 01 naming variants', () => {
    const files = [
      'C:\\Corpus\\Level 1\\2025\\Official Curriculum\\Volume 01.pdf',
      'C:\\Corpus\\Level 1\\2025\\Official Curriculum\\Volume 1.epub',
    ];

    expect([...pickCanonical(files)]).toEqual(['C:\\Corpus\\Level 1\\2025\\Official Curriculum\\Volume 1.epub']);
  });

  it('probes synthetic PDF page and text-layer quality', () => {
    expect(probePdfQuality(Buffer.from('%PDF /Type /Page BT visible text ET'), true)).toMatchObject({
      pageCount: 1,
      textOperatorCount: 1,
      extractableTextChars: 0,
      needsOcr: true,
    });
    const textLayerPdf = Buffer.from(`%PDF
1 0 obj << /Type /Page /Contents 2 0 R >> endobj
2 0 obj << /Length 120 >>
stream
BT /F1 12 Tf (Duration convexity yield curve private local searchable source text repeated for chunk quality.) Tj ET
endstream
endobj`);
    expect(probePdfQuality(textLayerPdf, true)).toMatchObject({
      pageCount: 1,
      textOperatorCount: 1,
      needsOcr: false,
    });
    expect(extractPdfText(textLayerPdf)).toContain('Duration convexity yield curve');
    expect(
      textChunksFromText(
        extractPdfText(textLayerPdf).repeat(3),
        'source:pdf',
        sha256(textLayerPdf),
        ['fixed-income'],
        '2026-05-06T00:00:00.000Z',
      ),
    ).toHaveLength(1);
  });

  it('deterministically blocks canonical PDFs with no extractable chunks', () => {
    const imageOnlyPdf = Buffer.from('%PDF /Type /Page /Contents 4 0 R');
    expect(
      textChunksFromText(
        extractPdfText(imageOnlyPdf),
        'source:scan',
        sha256(imageOnlyPdf),
        ['ethics'],
        '2026-05-06T00:00:00.000Z',
      ),
    ).toHaveLength(0);
    expect(probePdfQuality(imageOnlyPdf, true)).toMatchObject({
      pageCount: 1,
      textOperatorCount: 0,
      extractableTextChars: 0,
      needsOcr: true,
    });
  });
});
