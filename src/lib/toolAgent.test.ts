import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgentTurn, runAgent, type AgentTool } from './toolAgent';

vi.mock('./localLlm', () => ({
  generateText: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tool<T extends Record<string, unknown>>(name: string, fn: (input: T) => Promise<unknown>): AgentTool<T, unknown> {
  return {
    name,
    description: `A test tool named ${name}.`,
    inputSchema: { query: { type: 'string', description: 'A query string', required: true } },
    invoke: fn,
  };
}

describe('parseAgentTurn', () => {
  it('parses a plain action JSON', () => {
    const parsed = parseAgentTurn('{"thought":"need to look up","action":{"tool":"search","input":{"query":"NPV"}}}');
    expect(parsed?.action?.tool).toBe('search');
    expect(parsed?.thought).toBe('need to look up');
  });

  it('parses a plain answer JSON', () => {
    const parsed = parseAgentTurn('{"thought":"done","answer":"42"}');
    expect(parsed?.answer).toBe('42');
  });

  it('strips fenced code blocks', () => {
    const fenced = '```json\n{"thought":"x","answer":"y"}\n```';
    const parsed = parseAgentTurn(fenced);
    expect(parsed?.answer).toBe('y');
  });

  it('returns null for garbage', () => {
    expect(parseAgentTurn('I cannot do that.')).toBeNull();
    expect(parseAgentTurn('')).toBeNull();
    expect(parseAgentTurn('{this is not json')).toBeNull();
  });

  it('rejects objects missing both action and answer', () => {
    expect(parseAgentTurn('{"thought":"x"}')).toBeNull();
  });
});

describe('runAgent', () => {
  it('returns the final answer when the model emits an answer turn', async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      text: '{"thought":"trivial","answer":"NPV is the present value of cash flows."}',
    });
    const result = await runAgent({
      goal: 'Define NPV.',
      tools: [],
      generate,
    });
    expect(result.finished).toBe('answer');
    expect(result.answer).toContain('NPV');
    expect(result.trace).toHaveLength(1);
  });

  it('invokes a tool, then returns the answer using its output', async () => {
    const searchTool = tool('search', vi.fn().mockResolvedValue({ snippet: 'Duration measures bond price sensitivity.' }));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: '{"thought":"lookup","action":{"tool":"search","input":{"query":"duration"}}}',
      })
      .mockResolvedValueOnce({
        text: '{"thought":"got it","answer":"Duration measures bond price sensitivity to yield changes."}',
      });

    const result = await runAgent({
      goal: 'What does duration measure?',
      tools: [searchTool],
      generate,
    });
    expect(result.finished).toBe('answer');
    expect(result.answer).toContain('Duration');
    expect(searchTool.invoke).toHaveBeenCalledWith({ query: 'duration' });
    expect(result.trace.length).toBeGreaterThanOrEqual(2);
  });

  it('handles tool errors gracefully and continues', async () => {
    const failingTool = tool('search', vi.fn().mockRejectedValue(new Error('rate limited')));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: '{"thought":"try","action":{"tool":"search","input":{"query":"x"}}}',
      })
      .mockResolvedValueOnce({
        text: '{"thought":"fine, fallback","answer":"I could not look it up, but the general definition is X."}',
      });
    const result = await runAgent({
      goal: 'look something up',
      tools: [failingTool],
      generate,
    });
    expect(result.finished).toBe('answer');
    expect(result.trace[0].toolError).toContain('rate limited');
  });

  it('reroutes when the model picks an unknown tool', async () => {
    const realTool = tool('search', vi.fn().mockResolvedValue({ ok: true }));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: '{"thought":"try","action":{"tool":"hallucinated_tool","input":{}}}',
      })
      .mockResolvedValueOnce({
        text: '{"thought":"corrected","action":{"tool":"search","input":{"query":"x"}}}',
      })
      .mockResolvedValueOnce({
        text: '{"thought":"done","answer":"got it"}',
      });
    const result = await runAgent({
      goal: 'demo',
      tools: [realTool],
      generate,
    });
    expect(result.finished).toBe('answer');
    expect(realTool.invoke).toHaveBeenCalled();
  });

  it('hits the step cap when the model never emits an answer', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: '{"thought":"loop","action":{"tool":"search","input":{"query":"x"}}}',
    });
    const result = await runAgent({
      goal: 'demo',
      tools: [tool('search', vi.fn().mockResolvedValue('ok'))],
      maxSteps: 3,
      generate,
    });
    expect(result.finished).toBe('max-steps');
    expect(result.trace.length).toBe(3);
  });

  it('aborts after two consecutive parse failures', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: 'I cannot respond as JSON.' })
      .mockResolvedValueOnce({ text: 'Still not JSON.' });
    const result = await runAgent({
      goal: 'demo',
      tools: [],
      generate,
    });
    expect(result.finished).toBe('parse-error');
  });

  it('reports LLM errors as tool-error finished', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('local model server down'));
    const result = await runAgent({
      goal: 'demo',
      tools: [],
      generate,
    });
    expect(result.finished).toBe('tool-error');
    expect(result.answer).toContain('local model server down');
  });

  it('streams traces via onTrace as they happen', async () => {
    const searchTool = tool('search', vi.fn().mockResolvedValue({ snippet: 'x' }));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: '{"thought":"start","action":{"tool":"search","input":{"query":"x"}}}',
      })
      .mockResolvedValueOnce({
        text: '{"thought":"end","answer":"done"}',
      });

    const traces: unknown[] = [];
    await runAgent({
      goal: 'demo',
      tools: [searchTool],
      generate,
      onTrace: (t) => traces.push(t),
    });
    expect(traces.length).toBeGreaterThanOrEqual(2);
  });
});
