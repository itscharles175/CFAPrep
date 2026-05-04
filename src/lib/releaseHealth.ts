import { generateCoverageReport } from './contentValidation';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  getLevel1BatchProgress,
} from './curriculumValidation';

export type ReleaseGateStatus = 'ok' | 'warning' | 'blocked' | 'pending';

export interface BundleGateCheck {
  label: string;
  status: 'ok' | 'missing' | 'over-threshold' | 'not-found';
  asset?: {
    name: string;
    bytes: number;
    gzipBytes: number;
  } | null;
}

export interface BundleReportInput {
  generatedAt?: string;
  checks?: BundleGateCheck[];
}

export interface ReleaseCommandResult {
  id: string;
  command: string;
  status: 'ok' | 'blocked';
  exitCode: number | null;
  durationMs: number;
  completedAt: string;
}

export interface ReleaseGate {
  id: string;
  label: string;
  command?: string;
  status: ReleaseGateStatus;
  detail: string;
  required: boolean;
}

export interface ReleaseGateReport {
  generatedAt: string;
  status: ReleaseGateStatus;
  summary: {
    catalogErrors: number;
    catalogWarnings: number;
    curriculumErrors: number;
    curriculumWarnings: number;
    level1ExamReadyTopics: number;
    level1ValidatedTopics: number;
    level1TopicCount: number;
    releaseBlockers: number;
    releaseWarnings: number;
    bundleFailures: number | null;
  };
  gates: ReleaseGate[];
  blockers: string[];
  warnings: string[];
}

function worstStatus(statuses: ReleaseGateStatus[]): ReleaseGateStatus {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('warning')) return 'warning';
  if (statuses.includes('pending')) return 'pending';
  return 'ok';
}

function bundleGate(bundle?: BundleReportInput | null): ReleaseGate {
  if (!bundle) {
    return {
      id: 'bundle-report',
      label: 'Bundle thresholds',
      command: 'npm run build && npm run bundle:report',
      status: 'pending',
      detail: 'Bundle report has not been generated for this build.',
      required: true,
    };
  }

  const failures = (bundle.checks || []).filter((check) => check.status === 'missing' || check.status === 'over-threshold');
  return {
    id: 'bundle-report',
    label: 'Bundle thresholds',
    command: 'npm run build && npm run bundle:report',
    status: failures.length ? 'blocked' : 'ok',
    detail: failures.length
      ? `${failures.length} route bundle threshold check${failures.length === 1 ? '' : 's'} failed.`
      : `${bundle.checks?.length || 0} tracked route bundle checks passed.`,
    required: true,
  };
}

function commandGate({
  id,
  label,
  command,
  fallbackDetail,
  gateResults,
}: {
  id: string;
  label: string;
  command: string;
  fallbackDetail: string;
  gateResults?: Record<string, ReleaseCommandResult>;
}): ReleaseGate {
  const result = gateResults?.[id];
  if (!result) {
    return {
      id,
      label,
      command,
      status: 'pending',
      detail: fallbackDetail,
      required: true,
    };
  }

  return {
    id,
    label,
    command,
    status: result.status,
    detail: `${result.command} exited ${result.exitCode ?? 'unknown'} in ${Math.round(result.durationMs / 1000)}s.`,
    required: true,
  };
}

export function buildReleaseGateReport({
  bundle = null,
  gateResults,
  generatedAt = new Date().toISOString(),
}: {
  bundle?: BundleReportInput | null;
  gateResults?: Record<string, ReleaseCommandResult>;
  generatedAt?: string;
} = {}): ReleaseGateReport {
  const catalog = generateCoverageReport();
  const curriculum = generateCurriculumCoverageReport();
  const progress = getLevel1BatchProgress();
  const release = generateContentReleaseReport('level1');
  const bundleFailures = bundle?.checks
    ? bundle.checks.filter((check) => check.status === 'missing' || check.status === 'over-threshold').length
    : null;

  const catalogErrors = catalog.totals.errors;
  const catalogWarnings = catalog.totals.warnings;
  const curriculumErrors = curriculum.totals.errors;
  const curriculumWarnings = curriculum.totals.warnings;
  const level1PublicReady = progress.topicCount > 0 && progress.examReadyTopics === progress.topicCount && release.status === 'exam-ready';
  const contentHasErrors = catalogErrors + curriculumErrors > 0;

  const gates: ReleaseGate[] = [
    commandGate({
      id: 'verify',
      label: 'Verify command',
      command: 'npm run verify',
      fallbackDetail: 'Must be run before release; covers lint, tests, TypeScript, and production build.',
      gateResults,
    }),
    commandGate({
      id: 'audit',
      label: 'Dependency audit',
      command: 'npm run audit',
      fallbackDetail: 'Must report 0 production dependency vulnerabilities before release.',
      gateResults,
    }),
    {
      id: 'content-validation',
      label: 'Content validation',
      command: 'npm run content:validate',
      status: contentHasErrors || gateResults?.['content-validation']?.status === 'blocked' ? 'blocked' : catalogWarnings + curriculumWarnings ? 'warning' : 'ok',
      detail: `${catalogErrors + curriculumErrors} errors and ${catalogWarnings + curriculumWarnings} warnings across content and curriculum validators.`,
      required: true,
    },
    {
      id: 'level1-editorial',
      label: 'Level I editorial gate',
      command: 'npm run content:validate',
      status: level1PublicReady ? 'ok' : 'blocked',
      detail: `${progress.examReadyTopics}/${progress.topicCount} topics exam-ready; ${progress.validatedTopics} structurally validated; ${release.warnings} release warnings.`,
      required: true,
    },
    bundleGate(bundle),
    commandGate({
      id: 'smoke',
      label: 'Route smoke',
      command: 'npm run smoke',
      fallbackDetail: 'Must pass dashboard, CFA, quiz, mock, flashcards, vault, analytics, tools, and system routes.',
      gateResults,
    }),
    commandGate({
      id: 'fresh-import',
      label: 'Fresh-profile import',
      command: 'npm run fresh-import:check',
      fallbackDetail: 'Export/import must be verified in a clean IndexedDB profile before public release.',
      gateResults,
    }),
  ];

  const blockers = [
    ...(contentHasErrors ? ['Content or curriculum validators have blocking errors.'] : []),
    ...(!level1PublicReady ? ['Level I remains blocked from public exam-ready release until all template-derived rows are editorially replaced.'] : []),
    ...(bundleFailures ? [`${bundleFailures} tracked route bundle thresholds failed.`] : []),
  ];
  const warnings = [
    ...(catalogWarnings + curriculumWarnings ? [`${catalogWarnings + curriculumWarnings} content/curriculum warnings need triage.`] : []),
    ...(release.warnings ? [`Level I release report has ${release.warnings} warnings.`] : []),
  ];

  return {
    generatedAt,
    status: worstStatus(gates.map((gate) => gate.status)),
    summary: {
      catalogErrors,
      catalogWarnings,
      curriculumErrors,
      curriculumWarnings,
      level1ExamReadyTopics: progress.examReadyTopics,
      level1ValidatedTopics: progress.validatedTopics,
      level1TopicCount: progress.topicCount,
      releaseBlockers: release.blockingIssues + blockers.length,
      releaseWarnings: release.warnings,
      bundleFailures,
    },
    gates,
    blockers,
    warnings,
  };
}
