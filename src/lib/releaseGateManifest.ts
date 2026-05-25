export type ReleaseGateId =
  | 'verify'
  | 'audit'
  | 'content-validation'
  | 'level1-editorial'
  | 'level2-editorial'
  | 'level3-editorial'
  | 'source-audit'
  | 'stack-audit'
  | 'bundle-report'
  | 'smoke'
  | 'browser-regression'
  | 'visual-regression'
  | 'accessibility'
  | 'fresh-import'
  | 'content-report'
  | 'artifact-denylist'
  | 'release-checklist';

export type ReleaseGateCategory = 'quality' | 'content' | 'performance' | 'browser' | 'artifact' | 'release';

export interface ReleaseGateArtifactSchema {
  id: string;
  requiredPaths: string[];
  optionalPaths?: string[];
}

export interface ReleaseGateReportRetention {
  archiveRoot: string;
  keepLatest: number;
  immutable: boolean;
}

export interface ReleaseGateDefinition {
  id: ReleaseGateId;
  label: string;
  command: string;
  category: ReleaseGateCategory;
  required: boolean;
  fallbackDetail: string;
  artifactPaths: string[];
  dependsOn?: ReleaseGateId[];
  timeoutMs?: number;
  parallelGroup?: string;
  freshnessHours?: number;
  artifactSchema?: ReleaseGateArtifactSchema;
  reportRetention?: ReleaseGateReportRetention;
  failureTriage?: string[];
}

const retention: ReleaseGateReportRetention = {
  archiveRoot: 'dist/reports/release-history',
  keepLatest: 20,
  immutable: true,
};

export const releaseGateDefinitions: ReleaseGateDefinition[] = [
  {
    id: 'verify',
    label: 'Verify command',
    command: 'npm run verify',
    category: 'quality',
    required: true,
    fallbackDetail: 'Must be run before release; covers lint, tests, TypeScript, and production build.',
    artifactPaths: ['dist/'],
    timeoutMs: 600_000,
    parallelGroup: 'bootstrap',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.verify.v1', requiredPaths: ['dist/index.html'] },
    reportRetention: retention,
    failureTriage: ['Inspect lint/test/build stderr first.', 'Do not run downstream dist-dependent gates until verify is green.'],
  },
  {
    id: 'audit',
    label: 'Dependency audit',
    command: 'npm run audit',
    category: 'quality',
    required: true,
    fallbackDetail: 'Must report 0 production dependency vulnerabilities before release.',
    artifactPaths: [],
    dependsOn: ['verify'],
    timeoutMs: 120_000,
    parallelGroup: 'static-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.audit.v1', requiredPaths: [] },
    reportRetention: retention,
    failureTriage: ['Run npm audit --omit=dev and prefer upgrades over overrides for production dependencies.'],
  },
  {
    id: 'content-validation',
    label: 'Content validation',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Must validate catalog, curriculum map, and active editorial gates.',
    artifactPaths: [],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'content-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.content-validation.v1', requiredPaths: [] },
    reportRetention: retention,
    failureTriage: ['Open catalog and curriculum validation diagnostics before changing content-pack runtime paths.'],
  },
  {
    id: 'level1-editorial',
    label: 'Level I editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level I topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level1.json'],
    dependsOn: ['content-validation'],
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.level1-editorial.v1', requiredPaths: ['dist/reports/content-release-level1.json'] },
    reportRetention: retention,
  },
  {
    id: 'level2-editorial',
    label: 'Level II editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level II topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level2.json'],
    dependsOn: ['content-validation'],
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.level2-editorial.v1', requiredPaths: ['dist/reports/content-release-level2.json'] },
    reportRetention: retention,
  },
  {
    id: 'level3-editorial',
    label: 'Level III editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level III topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level3.json'],
    dependsOn: ['content-validation'],
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.level3-editorial.v1', requiredPaths: ['dist/reports/content-release-level3.json'] },
    reportRetention: retention,
  },
  {
    id: 'source-audit',
    label: 'CFA source audit',
    command: 'npm run cfa:source:audit',
    category: 'content',
    required: true,
    fallbackDetail: 'Private source text, .qvsource bundles, PDFs, and EPUBs must stay out of tracked files and release artifact roots.',
    artifactPaths: ['dist/reports/cfa-source-policy.json'],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'content-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.source-audit.v1', requiredPaths: ['dist/reports/cfa-source-policy.json'] },
    reportRetention: retention,
    failureTriage: ['Quarantine private source text or bundles outside tracked files and public release artifacts.'],
  },
  {
    id: 'stack-audit',
    label: 'Stack audit',
    command: 'npm run stack:audit',
    category: 'quality',
    required: true,
    fallbackDetail: 'Must pass route, PWA, artifact denylist, visual coverage, and release-manifest structural checks.',
    artifactPaths: ['dist/reports/stack-audit.json'],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'static-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.stack-audit.v1', requiredPaths: ['dist/reports/stack-audit.json'] },
    reportRetention: retention,
    failureTriage: ['Read stack-audit structural issues before changing routes, service worker, or release manifest metadata.'],
  },
  {
    id: 'bundle-report',
    label: 'Bundle thresholds',
    command: 'npm run bundle:report',
    category: 'performance',
    required: true,
    fallbackDetail: 'Must pass route, vendor, math, chart, and CFA chunk thresholds.',
    artifactPaths: ['dist/reports/bundle-report.json'],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'static-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.bundle-report.v1', requiredPaths: ['dist/reports/bundle-report.json'] },
    reportRetention: retention,
    failureTriage: ['Inspect route ownership budgets before increasing thresholds or merging chunks.'],
  },
  {
    id: 'smoke',
    label: 'Route smoke',
    command: 'npm run smoke',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass dashboard, CFA, quiz, mock, flashcards, vault, analytics, tools, and system routes.',
    artifactPaths: [],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'browser-smoke',
    freshnessHours: 12,
    artifactSchema: { id: 'qv.release.smoke.v1', requiredPaths: [] },
    reportRetention: retention,
    failureTriage: ['Open the failed route directly, then inspect route manifest expected text and async loaders.'],
  },
  {
    id: 'browser-regression',
    label: 'Browser regression',
    command: 'npm run browser:regression',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass async CFA loading, case flows, mock resume, offline reload, and update-prompt browser checks.',
    artifactPaths: [],
    dependsOn: ['smoke'],
    timeoutMs: 240_000,
    parallelGroup: 'browser-regression',
    freshnessHours: 12,
    artifactSchema: { id: 'qv.release.browser-regression.v1', requiredPaths: [] },
    reportRetention: retention,
    failureTriage: ['Use the route-level failure list before changing async data, mock state, or offline caching.'],
  },
  {
    id: 'visual-regression',
    label: 'Visual regression',
    command: 'npm run visual:regression',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must scan desktop and mobile screenshot routes for blank screens and obvious layout overflow.',
    artifactPaths: ['dist/reports/visual-regression.json'],
    dependsOn: ['smoke'],
    timeoutMs: 240_000,
    parallelGroup: 'visual-regression',
    freshnessHours: 12,
    artifactSchema: { id: 'qv.release.visual-regression.v1', requiredPaths: ['dist/reports/visual-regression.json'] },
    reportRetention: retention,
    failureTriage: ['Check the generated route screenshot report before changing layout primitives or route metadata.'],
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    command: 'npm run a11y:check',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass serious/critical WCAG axe checks across screenshot routes.',
    artifactPaths: ['dist/reports/a11y-check.json'],
    dependsOn: ['smoke'],
    timeoutMs: 240_000,
    parallelGroup: 'accessibility',
    freshnessHours: 12,
    artifactSchema: { id: 'qv.release.accessibility.v1', requiredPaths: ['dist/reports/a11y-check.json'] },
    reportRetention: retention,
    failureTriage: ['Resolve serious and critical axe violations before visual polish work.'],
  },
  {
    id: 'fresh-import',
    label: 'Fresh-profile import',
    command: 'npm run fresh-import:check',
    category: 'quality',
    required: true,
    fallbackDetail: 'Export/import must be verified in a clean IndexedDB profile before public release.',
    artifactPaths: [],
    dependsOn: ['verify'],
    timeoutMs: 180_000,
    parallelGroup: 'static-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.fresh-import.v1', requiredPaths: [] },
    reportRetention: retention,
    failureTriage: ['Inspect vault migration, checksum, and IndexedDB schema changes first.'],
  },
  {
    id: 'content-report',
    label: 'Content report',
    command: 'npm run content:report',
    category: 'artifact',
    required: true,
    fallbackDetail: 'Must generate release content reports and editorial inventory artifacts.',
    artifactPaths: ['dist/reports/content-report.json'],
    dependsOn: ['content-validation'],
    timeoutMs: 180_000,
    parallelGroup: 'content-post-verify',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.content-report.v1', requiredPaths: ['dist/reports/content-report.json'] },
    reportRetention: retention,
    failureTriage: ['Regenerate content reports after validator fixes so System Health reads current artifacts.'],
  },
  {
    id: 'release-checklist',
    label: 'Release checklist',
    command: 'npm run release:checklist',
    category: 'release',
    required: true,
    fallbackDetail: 'Must write release manifest and checklist artifacts from the canonical gate report.',
    artifactPaths: ['dist/reports/release-manifest.json', 'dist/reports/release-checklist.md'],
    dependsOn: [
      'audit',
      'content-validation',
      'source-audit',
      'stack-audit',
      'bundle-report',
      'smoke',
      'browser-regression',
      'visual-regression',
      'accessibility',
      'fresh-import',
      'content-report',
    ],
    timeoutMs: 120_000,
    parallelGroup: 'finalize',
    freshnessHours: 24,
    artifactSchema: {
      id: 'qv.release.checklist.v1',
      requiredPaths: ['dist/reports/release-manifest.json', 'dist/reports/release-checklist.md'],
    },
    reportRetention: retention,
    failureTriage: ['Release checklist should be the final gate and should read the canonical gate result report.'],
  },
];

export const executableReleaseGateDefinitions = releaseGateDefinitions.filter(
  (gate) => !gate.id.includes('editorial'),
);

export function releaseGateDefinitionById(id: ReleaseGateId) {
  return releaseGateDefinitions.find((gate) => gate.id === id);
}
