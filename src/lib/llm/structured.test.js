import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  StructuredOutputError,
  buildResponseFormat,
  extractJsonText,
  generateStructured,
  parseStructured,
} from './structured';

const McqSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  correct: z.number().int().nonnegative(),
});
const ArraySchema = z.array(McqSchema).min(1);

describe('buildResponseFormat', () => {
  it('builds a json_schema response_format when given a JSON schema', () => {
    const rf = buildResponseFormat({ type: 'object' }, 'my_schema');
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('my_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual({ type: 'object' });
  });

  it('falls back to json_object when no schema is supplied', () => {
    expect(buildResponseFormat()).toEqual({ type: 'json_object' });
  });
});

describe('extractJsonText — repair extraction', () => {
  it('returns clean JSON unchanged', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts JSON from a fenced ```json block', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nThanks!';
    expect(JSON.parse(extractJsonText(text))).toEqual({ a: 1 });
  });

  it('extracts a balanced object even with trailing prose', () => {
    const text = '{"a": {"b": 2}} and then some chatter about it';
    expect(JSON.parse(extractJsonText(text))).toEqual({ a: { b: 2 } });
  });

  it('extracts the first array', () => {
    const text = 'Sure: [1, 2, 3] hope that helps';
    expect(JSON.parse(extractJsonText(text))).toEqual([1, 2, 3]);
  });

  it('is string-aware (braces inside strings do not unbalance)', () => {
    const text = 'note {"a": "a } b", "c": 1} done';
    expect(JSON.parse(extractJsonText(text))).toEqual({ a: 'a } b', c: 1 });
  });

  it('returns null when no JSON value is present', () => {
    expect(extractJsonText('I cannot do that.')).toBeNull();
  });
});

describe('parseStructured — validate -> repair -> extract', () => {
  it('validates clean JSON directly', () => {
    const raw = JSON.stringify([{ question: 'q', options: ['a', 'b'], correct: 0 }]);
    const out = parseStructured(raw, ArraySchema);
    expect(out).toHaveLength(1);
    expect(out[0].correct).toBe(0);
  });

  it('repairs JSON wrapped in prose + code fences', () => {
    const raw = 'Sure!\n```json\n[{"question":"q","options":["a","b"],"correct":1}]\n```\nGood luck.';
    const out = parseStructured(raw, ArraySchema);
    expect(out[0].correct).toBe(1);
  });

  it('strips a <think> reasoning trace before parsing', () => {
    const raw = '<think>let me reason about the answer</think>[{"question":"q","options":["a","b"],"correct":0}]';
    const out = parseStructured(raw, ArraySchema);
    expect(out[0].question).toBe('q');
  });

  it('throws a typed StructuredOutputError on empty output', () => {
    expect(() => parseStructured('   ', ArraySchema)).toThrowError(StructuredOutputError);
    try {
      parseStructured('', ArraySchema);
    } catch (e) {
      expect(e.stage).toBe('empty');
      expect(e.isStructuredOutputError).toBe(true);
    }
  });

  it('throws a typed StructuredOutputError on unparseable output', () => {
    try {
      parseStructured('not json at all', ArraySchema);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredOutputError);
      expect(e.stage).toBe('parse');
    }
  });

  it('throws a typed StructuredOutputError on schema violation, carrying zod issues', () => {
    // Parseable JSON, but wrong shape (correct is a string, options too short).
    const raw = '[{"question":"q","options":["a"],"correct":"nope"}]';
    try {
      parseStructured(raw, ArraySchema);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredOutputError);
      expect(e.stage).toBe('validate');
      expect(Array.isArray(e.issues)).toBe(true);
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.raw).toBe(raw);
    }
  });
});

describe('generateStructured — transport orchestration', () => {
  it('passes responseFormat + systemSuffix to the transport and returns the validated value', async () => {
    const request = vi.fn(async ({ responseFormat, systemSuffix }) => {
      expect(responseFormat.type).toBe('json_schema');
      expect(typeof systemSuffix).toBe('string');
      return JSON.stringify([{ question: 'q', options: ['a', 'b'], correct: 0 }]);
    });
    const out = await generateStructured({
      schema: ArraySchema,
      jsonSchema: { type: 'array' },
      schemaName: 'mcqs',
      request,
    });
    expect(out[0].question).toBe('q');
    expect(request).toHaveBeenCalledOnce();
  });

  it('surfaces a StructuredOutputError when the model output cannot be coerced', async () => {
    const request = async () => 'absolutely not json';
    await expect(
      generateStructured({ schema: ArraySchema, request }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('requires a zod schema and a request function', async () => {
    await expect(generateStructured({ request: async () => '[]' })).rejects.toThrow(/zod/);
    await expect(generateStructured({ schema: ArraySchema })).rejects.toThrow(/transport/);
  });
});
