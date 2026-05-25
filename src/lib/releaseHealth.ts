import { generateCoverageReport } from './contentValidation';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  getLevel1BatchProgress,
} from './curriculumValidation';
import {
  releaseGateDefinitionById,
  type ReleaseGateCategory,
  type ReleaseGateDefinition,
  type ReleaseGateId,
} from './releaseGateManifest';

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
  id: ReleaseGateId;
  command: string;
  status: 'ok' | 'blocked';
  exitCode: number | null;
  durationMs: number;
  startedAt?: string;
  completedAt: string;
  artifactPaths?: string[];
  dependencies?: ReleaseGateId[];
  parallelGroup?: string;
  freshnessHours?: number;
  artifactSchema?: ReleaseGateDefinition['artifactSchema'];
  runId?: string;
  failureTriage?: string[];
  message?: string;
  routeFailures?: Array<{ routeId: string; path: string; message: string }>;
  git?: {
    sha?: string;
    shortSha?: string;
    branch?: string;
    dirty?: boolean;
  };
  runtime?: {
    node: string;
    platform: string;
    arch: string;
  };
}

export interface ReleaseGate {
  id: ReleaseGateId;
  label: string;
  command?: string;
  category: ReleaseGateCategory;
  status: ReleaseGateStatus;
  detail: string;
  required: boolean;
  artifactPaths: string[];
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  ageHours?: number;
  stale?: boolean;
  freshnessHours?: number;
  dependencies: ReleaseGateId[];
  parallelGroup?: string;
  artifactSchema?: ReleaseGateDefinition['artifactSchema'];
  runId?: string;
  git?: ReleaseCommandResult['git'];
  failureTriage?: string[];
}

export interface ReleaseGateReport {
  generatedAt: string;
  runId?: string;
  git?: ReleaseCommandResult['git'];
  staleGateCount: number;
  status: ReleaseGateStatus;
  summary: {
    catalogErrors: number;
    catalogWarnings: number;
    curriculumErrors: number;
    curriculumWarnings: number;
    level1ExamReadyTopics: number;
    level1ValidatedTopics: number;
    level1TopicCount: number;
    level2ExamReadyTopics: number;
    level2TopicCount: number;
    level3ExamReadyTopics: number;
    level3TopicCount: number;
    activeCurriculumWarnings: number;
    futureDiagnostics: number;
    releaseBlockers: number;
    releaseWarnings: number;
    bundleFailures: number | null;
  };
  gates: ReleaseGate[];
  blockers: string[];
  warnings: string[];
  activeLevels: string[];
  futureDiagnostics: string[];
}

function worstStatus(statuses: ReleaseGateStatus[]): ReleaseGateStatus {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('warning')) return 'warning';
  if (statuses.includes('pending')) return 'pending';
  return 'ok';
}

function gateAgeHours(completedAt?: string) {
  if (!completedAt) return undefined;
  const completed = new Date(completedAt).getTime();
  if (Number.isNaN(completed)) return undefined;
  return Math.max(0, Math.round(((Date.now() - completed) / (60 * 60 * 1000)) * 10) / 10);
}

function baseGate(definition: ReleaseGateDefinition, status: ReleaseGateStatus, detail: string, result?: ReleaseCommandResult): ReleaseGate {
  const freshnessHours = result?.freshnessHours ?? definition.freshnessHours;
  const ageHours = gateAgeHours(result?.completedAt);
  const stale = typeof ageHours === 'number' && typeof freshnessHours === 'number' && ageHours > freshnessHours;
  const nextStatus = stale && status === 'ok' ? 'warning' : status;
  return {
    id: definition.id,
    label: definition.label,
    command: definition.command,
    category: definition.category,
    status: nextStatus,
    detail: stale ? `${detail} Gate artifact is stale; rerun within ${freshnessHours}h freshness policy.` : detail,
    required: definition.required,
    artifactPaths: result?.artifactPaths || definition.artifactPaths,
    completedAt: result?.completedAt,
    durationMs: result?.durationMs,
    exitCode: result?.exitCode,
    ageHours,
    stale,
    freshnessHours,
    dependencies: result?.dependencies || definition.dependsOn || [],
    parallelGroup: result?.parallelGroup || definition.parallelGroup,
    artifactSchema: result?.artifactSchema || definition.artifactSchema,
    runId: result?.runId,
    git: result?.git,
    failureTriage: result?.failureTriage || definition.failureTriage,
  };
}

function bundleGate(bundle?: BundleReportInput | null, gateResults?: Record<string, ReleaseCommandResult>): ReleaseGate {
  const definition = releaseGateDefinitionById('bundle-report') as ReleaseGateDefinition;
  const result = gateResults?.['bundle-report'];
  if (result?.status === 'blocked') {
    return baseGate(definition, 'blocked', `${result.command} exited ${result.exitCode ?? 'unknown'} in ${Math.round(result.durationMs / 1000)}s.`, result);
  }
  if (!bundle) {
    return baseGate(definition, 'pending', 'Bundle report has not been generated for this build.', result);
  }

  const failures = (bundle.checks || []).filter((check) => check.status === 'missing' || check.status === 'over-threshold');
  return baseGate(
    definition,
    failures.length ? 'blocked' : 'ok',
    failures.length
      ? `${failures.length} route bundle threshold check${failures.length === 1 ? '' : 's'} failed.`
      : `${bundle.checks?.length || 0} tracked route bundle checks passed.`,
    result,
  );
}

function commandGate(definition: ReleaseGateDefinition, gateResults?: Record<string, ReleaseCommandResult>): ReleaseGate {
  const result = gateResults?.[definition.id];
  if (!result) {
    return baseGate(definition, 'pending', definition.fallbackDetail);
  }

  const routeFailureDetail = result.routeFailures?.length
    ? ` ${result.routeFailures.length} route-level failure${result.routeFailures.length === 1 ? '' : 's'} recorded: ${result.routeFailures
        .slice(0, 3)
        .map((failure) => `${failure.routeId} (${failure.path})`)
        .join(', ')}${result.routeFailures.length > 3 ? ', ...' : ''}.`
    : '';
  return baseGate(
    definition,
    result.status,
    `${result.command} exited ${result.exitCode ?? 'unknown'} in ${Math.round(result.durationMs / 1000)}s.${routeFailureDetail}`,
    result,
  );
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
  const activeCurriculumReports = [
    generateCurriculumCoverageReport('level1'),
    generateCurriculumCoverageReport('level2'),
    generateCurriculumCoverageReport('level3'),
  ];
  const futureCurriculumReports: ReturnType<typeof generateCurriculumCoverageReport>[] = [];
  const progress = getLevel1BatchProgress();
  const release = generateContentReleaseReport('level1');
  const level2Release = generateContentReleaseReport('level2');
  const level3Release = generateContentReleaseReport('level3');
  const bundleFailures = bundle?.checks
    ? bundle.checks.filter((check) => check.status === 'missing' || check.status === 'over-threshold').length
    : null;

  const catalogErrors = catalog.totals.errors;
  const catalogWarnings = catalog.totals.warnings;
  const curriculumErrors = activeCurriculumReports.reduce((sum, report) => sum + report.totals.errors, 0);
  const curriculumWarnings = activeCurriculumReports.reduce((sum, report) => sum + report.totals.warnings, 0);
  const futureDiagnostics = futureCurriculumReports.reduce((sum, report) => sum + report.totals.warnings + report.totals.errors, 0);
  const level1PublicReady = progress.topicCount > 0 && progress.examReadyTopics === progress.topicCount && release.status === 'exam-ready';
  const level2PublicReady = level2Release.topicIds.length > 0 && level2Release.topics.every((topic) => topic.status === 'exam-ready') && level2Release.status === 'exam-ready';
  const level3PublicReady = level3Release.topicIds.length > 0 && level3Release.topics.every((topic) => topic.status === 'exam-ready') && level3Release.status === 'exam-ready';
  const contentHasErrors = catalogErrors + curriculumErrors > 0;
  const definition = (id: ReleaseGateId) => releaseGateDefinitionById(id) as ReleaseGateDefinition;
  const contentValidationResult = gateResults?.['content-validation'];

  const gates: ReleaseGate[] = [
    commandGate(definition('verify'), gateResults),
    commandGate(definition('audit'), gateResults),
    baseGate(
      definition('content-validation'),
      contentHasErrors || contentValidationResult?.status === 'blocked' ? 'blocked' : catalogWarnings + curriculumWarnings ? 'warning' : 'ok',
      `${catalogErrors + curriculumErrors} errors and ${catalogWarnings + curriculumWarnings} warnings across content and curriculum validators.`,
      contentValidationResult,
    ),
    baseGate(
      definition('level1-editorial'),
      level1PublicReady ? 'ok' : 'blocked',
      `${progress.examReadyTopics}/${progress.topicCount} topics exam-ready; ${release.templateRowsRemaining} template rows remaining; ${release.warnings} release warnings.`,
      contentValidationResult,
    ),
    baseGate(
      definition('level2-editorial'),
      level2PublicReady ? 'ok' : 'blocked',
      `${level2Release.topics.filter((topic) => topic.status === 'exam-ready').length}/${level2Release.topicIds.length} topics exam-ready; ${level2Release.templateRowsRemaining} template rows remaining; ${level2Release.warnings} release warnings.`,
      contentValidationResult,
    ),
    baseGate(
      definition('level3-editorial'),
      level3PublicReady ? 'ok' : 'blocked',
      `${level3Release.topics.filter((topic) => topic.status === 'exam-ready').length}/${level3Release.topicIds.length} topics exam-ready; ${level3Release.templateRowsRemaining} template rows remaining; ${level3Release.warnings} release warnings.`,
      contentValidationResult,
    ),
    commandGate(definition('source-audit'), gateResults),
    commandGate(definition('stack-audit'), gateResults),
    bundleGate(bundle, gateResults),
    commandGate(definition('smoke'), gateResults),
    commandGate(definition('browser-regression'), gateResults),
    commandGate(definition('visual-regression'), gateResults),
    commandGate(definition('accessibility'), gateResults),
    commandGate(definition('fresh-import'), gateResults),
    commandGate(definition('content-report'), gateResults),
    commandGate(definition('release-checklist'), gateResults),
  ];
  const gateResultValues = Object.values(gateResults || {});
  const runId = gateResultValues.find((result) => result.runId)?.runId;
  const git = gateResultValues.find((result) => result.git)?.git;
  const staleGates = gates.filter((gate) => gate.stale);

  const blockers = [
    ...(contentHasErrors ? ['Content or curriculum validators have blocking errors.'] : []),
    ...(!level1PublicReady ? [`Level I remains blocked from public exam-ready release until all template-derived rows are editorially replaced (${release.templateRowsRemaining} remaining).`] : []),
    ...(!level2PublicReady ? [`Level II remains blocked from public exam-ready release until all item-set packs are editorially replaced (${level2Release.templateRowsRemaining} template rows remaining).`] : []),
    ...(!level3PublicReady ? [`Level III remains blocked from public exam-ready release until all constructed-response packs are editorially replaced (${level3Release.templateRowsRemaining} template rows remaining).`] : []),
    ...(bundleFailures ? [`${bundleFailures} tracked route bundle thresholds failed.`] : []),
    ...gates
      .filter((gate) => gate.status === 'blocked' && !gate.id.includes('editorial') && gate.id !== 'bundle-report' && gate.id !== 'content-validation')
      .map((gate) => `${gate.label} failed: ${gate.detail}`),
  ];
  const warnings = [
    ...(staleGates.length ? [`${staleGates.length} release gate artifact${staleGates.length === 1 ? ' is' : 's are'} stale and should be rerun.`] : []),
    ...(catalogWarnings + curriculumWarnings ? [`${catalogWarnings + curriculumWarnings} content/curriculum warnings need triage.`] : []),
    ...(release.warnings ? [`Level I release report has ${release.warnings} warnings.`] : []),
    ...(level2Release.warnings ? [`Level II release report has ${level2Release.warnings} warnings.`] : []),
    ...(level3Release.warnings ? [`Level III release report has ${level3Release.warnings} warnings.`] : []),
  ];

  return {
    generatedAt,
    runId,
    git,
    staleGateCount: staleGates.length,
    status: worstStatus(gates.map((gate) => gate.status)),
    summary: {
      catalogErrors,
      catalogWarnings,
      curriculumErrors,
      curriculumWarnings,
      level1ExamReadyTopics: progress.examReadyTopics,
      level1ValidatedTopics: progress.validatedTopics,
      level1TopicCount: progress.topicCount,
      level2ExamReadyTopics: level2Release.topics.filter((topic) => topic.status === 'exam-ready').length,
      level2TopicCount: level2Release.topicIds.length,
      level3ExamReadyTopics: level3Release.topics.filter((topic) => topic.status === 'exam-ready').length,
      level3TopicCount: level3Release.topicIds.length,
      activeCurriculumWarnings: curriculumWarnings,
      futureDiagnostics,
      releaseBlockers: release.blockingIssues + level2Release.blockingIssues + level3Release.blockingIssues + blockers.length,
      releaseWarnings: release.warnings + level2Release.warnings + level3Release.warnings,
      bundleFailures,
    },
    gates,
    blockers,
    warnings,
    activeLevels: ['level1', 'level2', 'level3'],
    futureDiagnostics: futureCurriculumReports.flatMap((report) => report.issues.map((issue) => `${issue.area}:${issue.id} - ${issue.message}`)),
  };
}
