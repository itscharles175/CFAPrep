import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainCurriculumFigure } from './figureUnderstanding';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function modelResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

describe('explainCurriculumFigure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid JSON object response', async () => {
    const payload = JSON.stringify({
      summary: 'A line chart of yields over time.',
      bullets: ['Long bond yields rose.', 'Short end stayed flat.'],
      axes: 'x: date, y: yield (%)',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelResponse(payload)));

    const result = await explainCurriculumFigure({
      imageBase64: 'AAAA',
      topicTitle: 'Yield Curve',
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
    });

    expect(result.topic).toBe('Yield Curve');
    expect(result.summary).toBe('A line chart of yields over time.');
    expect(result.bullets).toHaveLength(2);
    expect(result.axes).toBe('x: date, y: yield (%)');
    expect(typeof result.generatedAt).toBe('string');
  });

  it('strips fenced ```json … ``` code blocks before parsing', async () => {
    const fenced =
      '```json\n{\n  "summary": "Bar chart of returns.",\n  "bullets": ["A", "B"],\n  "axes": ""\n}\n```';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelResponse(fenced)));

    const result = await explainCurriculumFigure({
      imageBase64: 'AAAA',
      topicTitle: 'Returns',
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
    });
    expect(result.summary).toBe('Bar chart of returns.');
    expect(result.bullets).toEqual(['A', 'B']);
    // Empty axes string is dropped from the result object.
    expect(result.axes).toBeUndefined();
  });

  it('rejects when summary is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(modelResponse(JSON.stringify({ bullets: ['x'] }))),
    );
    await expect(
      explainCurriculumFigure({
        imageBase64: 'A',
        topicTitle: 'X',
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/summary/);
  });

  it('rejects when summary is an empty string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(modelResponse(JSON.stringify({ summary: '   ', bullets: ['x'] }))),
    );
    await expect(
      explainCurriculumFigure({
        imageBase64: 'A',
        topicTitle: 'X',
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/summary/);
  });

  it('caps bullets at 5 entries', async () => {
    const payload = JSON.stringify({
      summary: 'A diagram.',
      bullets: ['1', '2', '3', '4', '5', '6', '7', '8'],
      axes: '',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelResponse(payload)));

    const result = await explainCurriculumFigure({
      imageBase64: 'A',
      topicTitle: 'X',
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
    });
    expect(result.bullets).toHaveLength(5);
    expect(result.bullets).toEqual(['1', '2', '3', '4', '5']);
  });

  it('rejects unparseable model output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelResponse('not json at all here')));
    await expect(
      explainCurriculumFigure({
        imageBase64: 'A',
        topicTitle: 'X',
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/parseable JSON/);
  });
});
