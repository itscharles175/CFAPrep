export type ReleaseGateId =
  | 'verify'
  | 'audit'
  | 'content-validation'
  | 'level1-editorial'
  | 'level2-editorial'
  | 'level3-editorial'
  | 'bundle-report'
  | 'smoke'
  | 'browser-regression'
  | 'visual-regression'
  | 'accessibility'
  | 'fresh-import'
  | 'content-report'
  | 'release-checklist';

export type ReleaseGateCategory = 'quality' | 'content' | 'performance' | 'browser' | 'artifact' | 'release';

export interface ReleaseGateDefinition {
  id: ReleaseGateId;
  label: string;
  command: string;
  category: ReleaseGateCategory;
  required: boolean;
  fallbackDetail: string;
  artifactPaths: string[];
}

export const releaseGateDefinitions: ReleaseGateDefinition[] = [
  {
    id: 'verify',
    label: 'Verify command',
    command: 'npm run verify',
    category: 'quality',
    required: true,
    fallbackDetail: 'Must be run before release; covers lint, tests, TypeScript, and production build.',
    artifactPaths: ['dist/'],
  },
  {
    id: 'audit',
    label: 'Dependency audit',
    command: 'npm run audit',
    category: 'quality',
    required: true,
    fallbackDetail: 'Must report 0 production dependency vulnerabilities before release.',
    artifactPaths: [],
  },
  {
    id: 'content-validation',
    label: 'Content validation',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Must validate catalog, curriculum map, and active editorial gates.',
    artifactPaths: [],
  },
  {
    id: 'level1-editorial',
    label: 'Level I editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level I topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level1.json'],
  },
  {
    id: 'level2-editorial',
    label: 'Level II editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level II topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level2.json'],
  },
  {
    id: 'level3-editorial',
    label: 'Level III editorial gate',
    command: 'npm run content:validate',
    category: 'content',
    required: true,
    fallbackDetail: 'Every Level III topic must remain exam-ready with zero template rows.',
    artifactPaths: ['dist/reports/content-release-level3.json'],
  },
  {
    id: 'bundle-report',
    label: 'Bundle thresholds',
    command: 'npm run bundle:report',
    category: 'performance',
    required: true,
    fallbackDetail: 'Must pass route, vendor, math, chart, and CFA chunk thresholds.',
    artifactPaths: ['dist/reports/bundle-report.json'],
  },
  {
    id: 'smoke',
    label: 'Route smoke',
    command: 'npm run smoke',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass dashboard, CFA, quiz, mock, flashcards, vault, analytics, tools, and system routes.',
    artifactPaths: [],
  },
  {
    id: 'browser-regression',
    label: 'Browser regression',
    command: 'npm run browser:regression',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass async CFA loading, case flows, mock resume, offline reload, and update-prompt browser checks.',
    artifactPaths: [],
  },
  {
    id: 'visual-regression',
    label: 'Visual regression',
    command: 'npm run visual:regression',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must scan desktop and mobile screenshot routes for blank screens and obvious layout overflow.',
    artifactPaths: ['dist/reports/visual-regression.json'],
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    command: 'npm run a11y:check',
    category: 'browser',
    required: true,
    fallbackDetail: 'Must pass serious/critical WCAG axe checks across screenshot routes.',
    artifactPaths: ['dist/reports/a11y-check.json'],
  },
  {
    id: 'fresh-import',
    label: 'Fresh-profile import',
    command: 'npm run fresh-import:check',
    category: 'quality',
    required: true,
    fallbackDetail: 'Export/import must be verified in a clean IndexedDB profile before public release.',
    artifactPaths: [],
  },
  {
    id: 'content-report',
    label: 'Content report',
    command: 'npm run content:report',
    category: 'artifact',
    required: true,
    fallbackDetail: 'Must generate release content reports and editorial inventory artifacts.',
    artifactPaths: ['dist/reports/content-report.json'],
  },
  {
    id: 'release-checklist',
    label: 'Release checklist',
    command: 'npm run release:checklist',
    category: 'release',
    required: true,
    fallbackDetail: 'Must write release manifest and checklist artifacts from the canonical gate report.',
    artifactPaths: ['dist/reports/release-manifest.json', 'dist/reports/release-checklist.md'],
  },
];

export const executableReleaseGateDefinitions = releaseGateDefinitions.filter(
  (gate) => !gate.id.includes('editorial'),
);

export function releaseGateDefinitionById(id: ReleaseGateId) {
  return releaseGateDefinitions.find((gate) => gate.id === id);
}
