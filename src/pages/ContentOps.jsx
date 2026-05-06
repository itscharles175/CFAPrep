import { useMemo } from 'react';
import { CheckCircle2, FileSearch, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PageHeader, MetricCard } from '../components/ui/Primitives';
import { cfaContentBatches } from '../domains/cfa/contentPacks';
import { getCfaRuntimeReport } from '../domains/cfa/cfaSummary';
import { level1EditorialSprintOrder } from '../domains/cfa/level1Packs';
import { generateCoverageReport } from '../lib/contentValidation';
import { generateContentReleaseReport, generateCurriculumCoverageReport, getContentBatchProgress, getLevel1BatchProgress } from '../lib/curriculumValidation';

export default function ContentOps() {
  const report = useMemo(() => generateCoverageReport(), []);
  const curriculumReport = useMemo(() => generateCurriculumCoverageReport(), []);
  const activeCurriculumWarnings = useMemo(
    () =>
      generateCurriculumCoverageReport('level1').totals.warnings +
      generateCurriculumCoverageReport('level2').totals.warnings +
      generateCurriculumCoverageReport('level3').totals.warnings,
    [],
  );
  const level1Progress = useMemo(() => getLevel1BatchProgress(), []);
  const level2Progress = useMemo(() => getContentBatchProgress('level2'), []);
  const level3Progress = useMemo(() => getContentBatchProgress('level3'), []);
  const level1Release = useMemo(() => generateContentReleaseReport('level1'), []);
  const level2Release = useMemo(() => generateContentReleaseReport('level2'), []);
  const level3Release = useMemo(() => generateContentReleaseReport('level3'), []);
  const runtimeReport = useMemo(() => getCfaRuntimeReport(), []);
  const level1Runtime = runtimeReport.levels.find((item) => item.level === 'level1');
  const level2Runtime = runtimeReport.levels.find((item) => item.level === 'level2');
  const level3Runtime = runtimeReport.levels.find((item) => item.level === 'level3');
  const releaseSections = [
    {
      title: 'Level I Saturation Release',
      release: level1Release,
      progress: level1Progress,
      runtime: level1Runtime,
      vignetteLabel: 'mini-vignettes',
      sprint: `Sprint order: ${level1EditorialSprintOrder.join(' -> ')}`,
    },
    {
      title: 'Level II Item-Set Release',
      release: level2Release,
      progress: level2Progress,
      runtime: level2Runtime,
      vignetteLabel: 'item-set vignettes',
      sprint: 'Strict active gate: no partial public Level II exam-ready claim ships.',
    },
    {
      title: 'Level III Constructed-Response Release',
      release: level3Release,
      progress: level3Progress,
      runtime: level3Runtime,
      vignetteLabel: 'item-set vignettes',
      sprint: 'Strict active gate: no partial public Level III exam-ready claim ships.',
    },
  ];
  const hasErrors = report.totals.errors > 0;
  const curriculumHasErrors = curriculumReport.totals.errors > 0;
  const allIssues = [
    ...curriculumReport.issues.map((issue) => ({ ...issue, area: `curriculum:${issue.area}` })),
    ...report.issues.map((issue) => ({ ...issue, area: `catalog:${issue.area}` })),
  ];

  return (
    <div className="page-container">
      <PageHeader
        badge="CONTENT QA"
        title="Content Operations"
        subtitle="Coverage, answer-key, duplicate-question, formula-reference, and curriculum-map validation for the local catalog."
      />

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Levels" value={report.totals.levels ?? 1} detail={`${report.totals.topics} topics`} icon={FileSearch} />
        <MetricCard label="Questions" value={report.totals.questions} detail="Question bank rows" icon={ShieldCheck} tone="success" />
        <MetricCard label="Errors" value={report.totals.errors} detail="Must fix before release" icon={TriangleAlert} tone={hasErrors ? 'danger' : 'success'} />
        <MetricCard label="Exam-ready maps" value={curriculumReport.totals.examReadyTopics} detail={`${activeCurriculumWarnings} active warnings · 0 future diagnostics`} icon={CheckCircle2} tone={curriculumHasErrors ? 'danger' : activeCurriculumWarnings ? 'warning' : 'success'} />
      </div>

      {releaseSections.map(({ title, release, progress, runtime, vignetteLabel, sprint }) => (
        <div key={release.id} className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ marginTop: 0 }}>{title}</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
            {release.status} · {progress.examReadyTopics}/{progress.topicCount} topics exam-ready · {release.templateRowsRemaining} template rows remaining · {release.blockingIssues} blockers · {release.warnings} warnings · {progress.totalLessons} authored lessons · {progress.totalExamples} examples · {progress.totalQuestions} standalone questions · {progress.totalVignettes} {vignetteLabel} · {progress.totalFlashcards} flashcards · {progress.totalSkillLabs} mapped labs
          </p>
          <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
            Runtime mode: <strong>{runtime?.label || 'Generated scaffold'}</strong> · release eligible: {runtime?.releaseEligible ? 'yes' : 'no'} · {sprint}
          </p>
          <div className="coverage-grid">
            {release.topics.map((topic) => (
              <div key={`${release.level}:${topic.topicId}`}>
                <strong>{topic.title}</strong>
                <small>
                  {topic.status} · {topic.editorialRows}/{topic.totalRows} editorial rows · {topic.templateRowsRemaining} template rows · {topic.missingEvidence} missing evidence · {topic.blockers} blockers · {topic.warnings} warnings · reviewed by {topic.reviewer} on {topic.reviewedAt}
                </small>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Curriculum Authoring Map</h3>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          2026 structural map · {curriculumReport.totals.studyUnits} study units · {curriculumReport.totals.objectives} objective blueprints · {curriculumReport.totals.standaloneQuestions} standalone item specs · {curriculumReport.totals.vignettes} vignette specs · {curriculumReport.totals.flashcards} flashcard specs
        </p>
        <div className="coverage-grid">
          {curriculumReport.topics.map((topic) => (
            <div key={`curriculum:${topic.level}:${topic.id}`}>
              <strong>{topic.title}</strong>
              <small>
                {topic.level} · {topic.maturity} · {topic.studyUnits} units · {topic.lessonSections} sections · {topic.objectives} objectives · {topic.formulas} formulas · {topic.standaloneQuestions} item specs · {topic.vignettes} vignettes · {topic.constructedResponses} responses · {topic.skillLabs} labs
              </small>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Content Batches</h3>
        <div className="coverage-grid">
          {cfaContentBatches.map((batch) => (
            <div key={batch.id}>
              <strong>{batch.title}</strong>
              <small>
                {batch.level} · {batch.maturity} · sequence {batch.sequence} · {batch.topicIds.join(', ')} · {batch.packs.length} typed packs · {batch.acceptanceCriteria.length} gates
              </small>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>CFA All-Level Coverage</h3>
        <div className="coverage-grid">
          {report.topics.map((topic) => (
            <div key={`${topic.level}:${topic.id}`}>
              <strong>{topic.title}</strong>
              <small>
                {topic.level} · {topic.maturity} · {topic.sections} sections · {topic.objectives} objectives · {topic.formulas} formulas · {topic.questions} questions · {topic.vignettes} vignettes · {topic.constructedResponses} responses · {topic.skillLabs} labs · {topic.readinessCoverage}% coverage
              </small>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-card no-hover">
        <h3 style={{ marginTop: 0 }}>Issues</h3>
        {allIssues.length ? (
          <div className="vault-list">
            {allIssues.map((issue) => (
              <div key={`${issue.area}:${issue.id}:${issue.message}`} className="vault-row">
                <div>
                  <span className={`badge ${issue.severity === 'error' ? 'badge-red' : 'badge-amber'}`}>{issue.severity}</span>
                  <h4>{issue.area} · {issue.id}</h4>
                  <p>{issue.message}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>No content validation issues found.</p>
        )}
      </div>
    </div>
  );
}
