import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTextWithImages } from './visionAdapter';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('generateTextWithImages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a multi-part user message with text + image_url segments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'A bar chart of returns.' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateTextWithImages({
      prompt: 'Describe this figure.',
      images: [
        { base64: 'AAAA', mime: 'image/png' },
        { base64: 'BBBB', mime: 'image/jpeg' },
      ],
      system: 'You are a CFA tutor.',
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
    });

    expect(result).toEqual({ text: 'A bar chart of returns.', usedImages: 2 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gemma-4-e4b-it');
    const systemMessage = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toBe('You are a CFA tutor.');

    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[0]).toEqual({ type: 'text', text: 'Describe this figure.' });
    expect(userMessage.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
    expect(userMessage.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,BBBB' },
    });
  });

  it('encodes each supported mime type into its data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateTextWithImages({
      prompt: 'p',
      images: [
        { base64: 'PNGBASE', mime: 'image/png' },
        { base64: 'JPGBASE', mime: 'image/jpeg' },
        { base64: 'WEBPBASE', mime: 'image/webp' },
        { base64: 'NOMIME' },
      ],
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
    const urls = userMessage.content
      .filter((part: { type: string }) => part.type === 'image_url')
      .map((part: { image_url: { url: string } }) => part.image_url.url);
    expect(urls).toEqual([
      'data:image/png;base64,PNGBASE',
      'data:image/jpeg;base64,JPGBASE',
      'data:image/webp;base64,WEBPBASE',
      'data:image/png;base64,NOMIME',
    ]);
  });

  it('returns { text, usedImages } from a happy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'Looks like a yield curve.' } }] }),
      ),
    );
    const result = await generateTextWithImages({
      prompt: 'Describe.',
      images: [{ base64: 'A' }],
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
    });
    expect(result.text).toBe('Looks like a yield curve.');
    expect(result.usedImages).toBe(1);
  });

  it('strips reasoning traces from multimodal responses before returning text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            { message: { content: '<think>inspect labels privately</think>The chart slopes downward.' } },
          ],
        }),
      ),
    );

    const result = await generateTextWithImages({
      prompt: 'Describe.',
      images: [{ base64: 'A' }],
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
    });

    expect(result).toEqual({ text: 'The chart slopes downward.', usedImages: 1 });
  });

  it('wraps a network failure in the actionable LM Studio CORS message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      generateTextWithImages({
        prompt: 'p',
        images: [{ base64: 'A' }],
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/CORS|OLLAMA_ORIGINS/);
  });

  it('rejects remote vision model bases before sending images', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateTextWithImages({
        prompt: 'p',
        images: [{ base64: 'A' }],
        settings: { baseUrl: 'http://192.168.1.5:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the server responds with a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    await expect(
      generateTextWithImages({
        prompt: 'p',
        images: [{ base64: 'A' }],
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      }),
    ).rejects.toThrow(/500/);
  });
});
