import { describe, expect, it } from 'vitest';
import { evaluateOpenNotebookSourcePin, isFullCommitSha } from './check-onb-source-pin.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = '89abcdef0123456789abcdef0123456789abcdef';

describe('open-notebook source pin check', () => {
  it('accepts a present clean source at the pinned commit', () => {
    expect(
      evaluateOpenNotebookSourcePin({
        dirPresent: true,
        expectedRef: SHA,
        actualHead: SHA.toUpperCase(),
        dirtyOutput: '',
      }),
    ).toEqual({ ok: true, skipped: false, errors: [] });
  });

  it('skips missing optional source but fails missing required source', () => {
    expect(evaluateOpenNotebookSourcePin({ dirPresent: false, optional: true })).toEqual({
      ok: true,
      skipped: true,
      errors: [],
    });

    expect(evaluateOpenNotebookSourcePin({ dirPresent: false, optional: false })).toEqual({
      ok: false,
      skipped: false,
      errors: ['open-notebook source directory is missing'],
    });
  });

  it('rejects a branch, short SHA, or missing pin', () => {
    expect(isFullCommitSha(SHA)).toBe(true);
    expect(isFullCommitSha('main')).toBe(false);
    expect(isFullCommitSha(SHA.slice(0, 12))).toBe(false);

    expect(
      evaluateOpenNotebookSourcePin({
        dirPresent: true,
        expectedRef: 'main',
        actualHead: SHA,
      }).errors,
    ).toContain('open-notebook source must be pinned to a full 40-character commit SHA');

    expect(
      evaluateOpenNotebookSourcePin({
        dirPresent: true,
        expectedRef: '',
        actualHead: SHA,
      }).errors,
    ).toContain('ONB_GIT_REF/--expected is required when open-notebook source is present');
  });

  it('rejects mismatched HEAD and dirty source tree', () => {
    const result = evaluateOpenNotebookSourcePin({
      dirPresent: true,
      expectedRef: SHA,
      actualHead: OTHER_SHA,
      dirtyOutput: ' M pyproject.toml',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`open-notebook HEAD ${OTHER_SHA} does not match pinned commit ${SHA}`);
    expect(result.errors).toContain('open-notebook source tree has uncommitted changes');
  });
});
