import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateCommandCheck,
  evaluatePortProbe,
  evaluateSidecarProvenance,
  exitCodeForSummary,
  parseArgs,
  summarizeChecks,
} from './stack-doctor.mjs';

describe('stack-doctor argument parsing', () => {
  it('parses --all, --strict, --json, --output and --python', () => {
    const args = parseArgs(['--all', '--strict', '--json', '--output', 'dist/x.json', '--python', 'py']);
    expect(args.all).toBe(true);
    expect(args.strict).toBe(true);
    expect(args.json).toBe(true);
    expect(args.output.endsWith('dist\\x.json') || args.output.endsWith('dist/x.json')).toBe(true);
    expect(args.python).toBe('py');
  });

  it('rejects unknown arguments instead of ignoring them', () => {
    expect(() => parseArgs(['--typo'])).toThrow(/unknown argument/);
  });
});

describe('stack-doctor summary policy', () => {
  const checks = [
    { status: 'pass' },
    { status: 'warn' },
    { status: 'skip' },
  ];

  it('allows warnings by default', () => {
    const summary = summarizeChecks(checks);
    expect(summary.status).toBe('passed');
    expect(exitCodeForSummary(summary)).toBe(0);
  });

  it('turns warnings into failures in strict mode', () => {
    const summary = summarizeChecks(checks, { strict: true });
    expect(summary.status).toBe('failed');
    expect(exitCodeForSummary(summary)).toBe(1);
  });
});

describe('stack-doctor command checks', () => {
  it('maps a passing command to a passing check', () => {
    const check = evaluateCommandCheck(
      { id: 'x', label: 'tool', command: 'tool', args: ['--version'] },
      () => ({ exitCode: 0, stdoutTail: 'tool 1.2.3\n', stderrTail: '', timedOut: false }),
    );
    expect(check.status).toBe('pass');
    expect(check.details).toBe('tool 1.2.3');
  });

  it('maps optional missing tools to warnings', () => {
    const check = evaluateCommandCheck(
      { id: 'x', label: 'cargo', command: 'cargo', args: ['--version'], required: false },
      () => ({ exitCode: null, stdoutTail: '', stderrTail: '', timedOut: false, error: 'ENOENT' }),
    );
    expect(check.status).toBe('warn');
    expect(check.remediation).toContain('Optional tool');
  });
});

describe('stack-doctor sidecar provenance', () => {
  function tempRepo() {
    const root = mkdtempSync(join(tmpdir(), 'stack-doctor-'));
    mkdirSync(join(root, 'src-tauri', 'resources', 'services', 'lsat-backend'), { recursive: true });
    return root;
  }

  it('passes when a staged sidecar matches the recorded hash and size', () => {
    const root = tempRepo();
    const artifactRel = join('lsat-backend', 'lsatlab-backend.exe');
    const artifactAbs = join(root, 'src-tauri', 'resources', 'services', artifactRel);
    writeFileSync(artifactAbs, 'binary');
    writeFileSync(
      join(root, 'src-tauri', 'resources', 'services', 'sidecar-provenance.json'),
      JSON.stringify({
        schema: 'studyvault.sidecar-provenance.v1',
        entries: [
          {
            service: 'LSAT backend',
            path: artifactRel,
            sha256: '9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd',
            size: 6,
            optional: false,
          },
        ],
      }),
    );

    const checks = evaluateSidecarProvenance(root);
    expect(checks.map((check) => check.status)).toEqual(['pass', 'pass']);
  });

  it('fails required artifacts when the staged hash drifts', () => {
    const root = tempRepo();
    const artifactRel = join('lsat-backend', 'lsatlab-backend.exe');
    const artifactAbs = join(root, 'src-tauri', 'resources', 'services', artifactRel);
    writeFileSync(artifactAbs, 'changed');
    writeFileSync(
      join(root, 'src-tauri', 'resources', 'services', 'sidecar-provenance.json'),
      JSON.stringify({
        entries: [
          {
            service: 'LSAT backend',
            path: artifactRel,
            sha256: '9a3a45d01531a20e89ac6ae10b0b0beb049fa0f15806e9b6cd7a3352c960a899',
            size: 6,
            optional: false,
          },
        ],
      }),
    );

    const artifactCheck = evaluateSidecarProvenance(root).at(-1);
    expect(artifactCheck.status).toBe('fail');
    expect(artifactCheck.details).toContain('does not match');
  });
});

describe('stack-doctor port probes', () => {
  it('accepts an LSAT health response with the expected service identity', () => {
    const check = evaluatePortProbe(
      { id: 'p', label: 'LSAT backend', port: 8100, expected: 'lsat-backend', expectedService: 'lsat-backend' },
      { open: true, health: { ok: true, service: 'lsat-backend', version: '0.9.0' } },
    );
    expect(check.status).toBe('pass');
  });

  it('fails an occupied LSAT port that does not identify as the backend', () => {
    const check = evaluatePortProbe(
      { id: 'p', label: 'LSAT backend', port: 8100, expected: 'lsat-backend', expectedService: 'lsat-backend' },
      { open: true, health: { ok: true, service: 'other' } },
    );
    expect(check.status).toBe('fail');
    expect(check.remediation).toContain('foreign');
  });
});
