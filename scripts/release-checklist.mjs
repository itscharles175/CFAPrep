import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildReleaseGateReport } from '../src/lib/releaseHealth.ts';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const bundle = await readJson('dist/reports/bundle-report.json', null);
const gateResults = await readJson('dist/reports/release-gate-results.json', null);
const report = buildReleaseGateReport({ bundle, gateResults: gateResults?.resultsById });

const markdown = `# QuantVault Release Checklist

Generated: ${report.generatedAt}

## Status

- Overall: ${report.status}
- Catalog: ${report.summary.catalogErrors} errors, ${report.summary.catalogWarnings} warnings.
- Curriculum: ${report.summary.curriculumErrors} errors, ${report.summary.curriculumWarnings} warnings.
- Level I release: ${report.summary.level1ExamReadyTopics}/${report.summary.level1TopicCount} exam-ready, ${report.summary.level1ValidatedTopics} validated, ${report.summary.releaseWarnings} warnings.
- Bundle report: ${report.summary.bundleFailures === null ? 'not generated' : `${report.summary.bundleFailures} failures`}.

## Required Gates

${report.gates.map((gate) => `- [ ] ${gate.label} (${gate.status})${gate.command ? `: \`${gate.command}\`` : ''} — ${gate.detail}`).join('\n')}

## Blockers

${report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- None'}

## Warnings

${report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : '- None'}

## Notes

- Level I saturation packs are currently structurally validated. Packs with template-generated provenance must be editorially replaced before public exam-ready release.
- Core behavior remains local-first: no backend, account, cloud sync, payment, or required AI.
`;

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/release-manifest.json', `${JSON.stringify(report, null, 2)}\n`);
await writeFile('dist/reports/release-checklist.md', markdown);
console.log('Wrote dist/reports/release-manifest.json');
console.log('Wrote dist/reports/release-checklist.md');
