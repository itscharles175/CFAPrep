import { useMemo } from 'react';
import { CheckCircle2, FileSearch, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PageHeader, MetricCard } from '../components/ui/Primitives';
import { cfaContentBatches } from '../domains/cfa/contentPacks';
import { getCfaRuntimeReport } from '../domains/cfa/cfaLevels';
import { generateCoverageReport } from '../lib/contentValidation';
import { generateContentReleaseReport, generateCurriculumCoverageReport, getLevel1BatchProgress } from '../lib/curriculumValidation';

export default function ContentOps() {
  const report = useMemo(() => generateCoverageReport(), []);
  const curriculumReport = useMemo(() => generateCurriculumCoverageReport(), []);
  const level1Progress = useMemo(() => getLevel1BatchProgress(), []);
  const releaseReport = useMemo(() => generateContentReleaseReport('level1'), []);
  const runtimeReport = useMemo(() => getCfaRuntimeReport(), []);
  const level1Runtime = runtimeReport.levels.find((item) => item.level === 'level1');
  const hasErrors = report.totals.errors > 0;
  const curriculumHasErrors = curriculumReport.totals.errors > 0;
  const allIssues = useMemo(
    () => [
      ...curriculumReport.issues.map((issue) => ({ ...issue, area: `curriculum:${issue.area}` })),
      ...report.issues.map((issue) => ({ ...issue, area: `catalog:${issue.area}` })),
    ],
    [curriculumReport.issues, report.issues],
  );

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
        <MetricCard label="Exam-ready maps" value={curriculumReport.totals.examReadyTopics} detail={`${curriculumReport.totals.warnings} editorial warnings`} icon={CheckCircle2} tone={curriculumHasErrors ? 'danger' : 'warning'} />
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Level I Saturation Release</h3>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          {releaseReport.status} · {level1Progress.examReadyTopics}/{level1Progress.topicCount} topics exam-ready · {level1Progress.validatedTopics} validated · {releaseReport.blockingIssues} blockers · {releaseReport.warnings} warnings · {level1Progress.totalLessons} authored lessons · {level1Progress.totalExamples} examples · {level1Progress.totalQuestions} standalone questions · {level1Progress.totalVignettes} mini-vignettes · {level1Progress.totalFlashcards} flashcards · {level1Progress.totalSkillLabs} mapped labs
        </p>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          Runtime mode: <strong>{level1Runtime?.label || 'Generated scaffold'}</strong> · release eligible: {level1Runtime?.releaseEligible ? 'yes' : 'no'} · {level1Runtime?.warnings?.[0] || 'No runtime warnings'}
        </p>
        <div className="coverage-grid">
          {cfaContentBatches[0].packs.map((pack) => (
            <div key={pack.id}>
              <strong>{pack.title}</strong>
              <small>
                {pack.maturity} · {pack.provenance?.editorialStatus || 'unreviewed'} · {pack.provenance?.generatedFromTemplate ? 'template rows' : 'editorial rows'} · {pack.objectiveBlueprints.length} objectives · {pack.lessonBlueprints.reduce((sum, lesson) => sum + lesson.sectionTitles.length, 0)} sections · {pack.questionPacks.reduce((sum, questionPack) => sum + questionPack.count, 0)} standalone items · {pack.vignettePacks.reduce((sum, vignettePack) => sum + vignettePack.count, 0)} mini-vignettes · {pack.flashcardPacks.reduce((sum, flashcardPack) => sum + flashcardPack.count, 0)} flashcards
              </small>
            </div>
          ))}
        </div>
      </div>

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
