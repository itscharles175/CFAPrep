// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scanText } from './check-no-egress.mjs';

describe('check-no-egress scanner', () => {
  it('flags a direct non-loopback fetch endpoint', () => {
    const findings = scanText("await fetch('https://telemetry.example/collect')", 'src/x.js');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/x.js',
      line: 1,
      host: 'telemetry.example',
    });
  });

  it('flags endpoint-shaped remote assignments', () => {
    const findings = scanText("const API_BASE = 'https://api.example.com/v1';", 'src/x.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0].host).toBe('api.example.com');
  });

  it('ignores comments, docs metadata, namespaces, and loopback endpoints', () => {
    const findings = scanText(
      [
        "// fetch('https://telemetry.example/collect')",
        "const doc = { url: 'https://docs.example/help' };",
        "const svg = 'https://www.w3.org/2000/svg';",
        "await fetch('http://127.0.0.1:8100/api/health');",
      ].join('\n'),
      'src/x.js',
    );
    expect(findings).toEqual([]);
  });

  it('suppresses documented allowlisted egress only for the pinned file and host', () => {
    const allowed = scanText(
      "CLOUD_API_URL = 'https://api.anthropic.com/v1/messages'",
      'services/lsat-backend/app/config.py',
    );
    const unpinned = scanText(
      "CLOUD_API_URL = 'https://api.anthropic.com/v1/messages'",
      'src/x.js',
    );

    expect(allowed).toEqual([]);
    expect(unpinned).toHaveLength(1);
  });
});
