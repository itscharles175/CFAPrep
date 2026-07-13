import { describe, expect, it } from 'vitest';
import {
  MUTATION_FLOOR_SCHEMA,
  applyMutationToText,
  classifyMutationResult,
  formatMutationMarkdown,
  summarizeMutationResults,
} from './mutation-floor.mjs';

describe('mutation floor helpers', () => {
  it('applies a mutation only when the target occurrence is unambiguous', () => {
    expect(applyMutationToText('const x = 1;\n', { id: 'm1', find: '1', replace: '2' })).toBe('const x = 2;\n');
    expect(() => applyMutationToText('const x = 1; const y = 1;', { id: 'm2', find: '1', replace: '2' })).toThrow(
      /expected 1 occurrence/,
    );
  });

  it('computes a fail-closed score with no survivors allowed', () => {
    const passing = summarizeMutationResults([
      { id: 'a', status: 'killed' },
      { id: 'b', status: 'killed' },
    ]);
    const failing = summarizeMutationResults([
      { id: 'a', status: 'killed' },
      { id: 'b', status: 'survived' },
    ]);

    expect(passing.ok).toBe(true);
    expect(passing.score).toBe(1);
    expect(failing.ok).toBe(false);
    expect(failing.survivors).toEqual(['b']);
  });

  it('keeps command launch errors separate from killed mutants', () => {
    expect(classifyMutationResult({ status: 1, signal: null, error: null })).toBe('killed');
    expect(classifyMutationResult({ status: 0, signal: null, error: null })).toBe('survived');
    expect(classifyMutationResult({ status: null, signal: null, error: 'spawn failed' })).toBe('error');

    const summary = summarizeMutationResults([
      { id: 'a', status: 'killed' },
      { id: 'b', status: 'error' },
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.errors).toEqual(['b']);
  });

  it('formats a stable markdown report', () => {
    const markdown = formatMutationMarkdown({
      schemaVersion: MUTATION_FLOOR_SCHEMA,
      generatedAt: '2026-07-06T00:00:00.000Z',
      summary: { score: 1, killed: 1, total: 1, minScore: 1 },
      results: [{ id: 'mutant', file: 'src/lib/example.ts', status: 'killed' }],
    });

    expect(markdown).toContain('# Mutation Floor Report');
    expect(markdown).toContain('Score: 100.0% (1/1)');
    expect(markdown).toContain('| mutant | src/lib/example.ts | killed |');
  });
});
