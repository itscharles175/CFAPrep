import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PODCAST_VOICES,
  generatePodcastScript,
  resetKokoroLoader,
} from './podcast';
import { db } from './progressStore';

beforeEach(async () => {
  await db.settings.clear();
  resetKokoroLoader();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PODCAST_VOICES', () => {
  it('maps both roles to kokoro voice ids', () => {
    expect(PODCAST_VOICES.coach).toBe('af_heart');
    expect(PODCAST_VOICES.student).toBe('am_michael');
  });
});

describe('generatePodcastScript', () => {
  const SCRIPT_JSON = JSON.stringify({
    lines: [
      { role: 'coach', text: 'Welcome to today\'s episode on time value of money.' },
      { role: 'student', text: 'What\'s the first thing I should remember about discounting?' },
      { role: 'coach', text: 'That a cash flow\'s value depends on when it arrives.' },
      { role: 'student', text: 'So a dollar today beats a dollar next year?' },
      { role: 'coach', text: 'Exactly — and the discount rate captures by how much.' },
    ],
  });

  function makeClient() {
    return {
      generateText: vi.fn(async () => ({ text: SCRIPT_JSON })),
    };
  }

  it('parses lines and returns a structured script', async () => {
    const script = await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'Time Value of Money',
      client: makeClient(),
    });
    expect(script.lines).toHaveLength(5);
    expect(script.lines[0].role).toBe('coach');
    expect(script.lines[1].role).toBe('student');
    expect(script.title).toBe('Time Value of Money');
    expect(script.generatedAt).toBeTruthy();
  });

  it('caches scripts by (level, topic)', async () => {
    const client = makeClient();
    const a = await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'Time Value of Money',
      client,
    });
    const b = await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'Time Value of Money',
      client,
    });
    expect(client.generateText).toHaveBeenCalledTimes(1);
    expect(a.generatedAt).toBe(b.generatedAt);
  });

  it('forces refresh when asked', async () => {
    const client = makeClient();
    await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'Time Value of Money',
      client,
    });
    await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'Time Value of Money',
      client,
      forceRefresh: true,
    });
    expect(client.generateText).toHaveBeenCalledTimes(2);
  });

  it('rejects model output with no JSON object', async () => {
    const client = {
      generateText: vi.fn(async () => ({ text: 'I cannot respond.' })),
    };
    await expect(
      generatePodcastScript({
        level: 'level1',
        topic: 'quant',
        title: 'Time Value of Money',
        client,
      }),
    ).rejects.toThrow(/JSON/i);
  });

  it('rejects scripts with fewer than 4 lines', async () => {
    const client = {
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          lines: [
            { role: 'coach', text: 'Hi.' },
            { role: 'student', text: 'Hello.' },
          ],
        }),
      })),
    };
    await expect(
      generatePodcastScript({
        level: 'level1',
        topic: 'quant',
        title: 'Time Value of Money',
        client,
      }),
    ).rejects.toThrow(/usable lines/i);
  });

  it('filters out invalid roles silently', async () => {
    const client = {
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          lines: [
            { role: 'COACH', text: 'L1' },
            { role: 'narrator', text: 'should be dropped' },
            { role: 'student', text: 'L2' },
            { role: 'coach', text: 'L3' },
            { role: 'student', text: 'L4' },
          ],
        }),
      })),
    };
    const script = await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'TVM',
      client,
    });
    expect(script.lines).toHaveLength(4);
    expect(script.lines.every((l) => l.role === 'coach' || l.role === 'student')).toBe(true);
  });

  it('includes source excerpts in the prompt when provided', async () => {
    const client = makeClient();
    await generatePodcastScript({
      level: 'level1',
      topic: 'quant',
      title: 'TVM',
      sourceExcerpts: ['NPV is the present value of future cash flows.', 'IRR is the discount rate where NPV=0.'],
      client,
    });
    expect(client.generateText).toHaveBeenCalledTimes(1);
    const calls = client.generateText.mock.calls as unknown as Array<[{ prompt: string; system?: string }]>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const call = calls[0][0];
    expect(call.prompt).toContain('NPV is the present value');
    expect(call.prompt).toContain('IRR is the discount rate');
    expect(call.system).toContain('Coach');
  });
});
