import { useEffect, useMemo, useState } from 'react';
import { BookText, CheckCircle2, FileSearch, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PageHeader, MetricCard, Panel, StatusBadge } from '../components/ui/Primitives';
import { cfaContentBatches } from '../domains/cfa/contentPacks';
import { getCfaRuntimeReport } from '../domains/cfa/cfaSummary';
import { level1EditorialSprintOrder } from '../domains/cfa/level1Packs';
import { generateCoverageReport } from '../lib/contentValidation';
import { generateContentReleaseReport, generateCurriculumCoverageReport, getContentBatchProgress, getLevel1BatchProgress } from '../lib/curriculumValidation';
import { getCfaSourceCoverageMap, getCfaSourceMapStatus } from '../lib/cfaSourceVault';
import { SourceLinkManager, SourceMapStatus } from '../components/SourceContext';

export default function ContentOps() {
  const [sourceCoverage, setSourceCoverage] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [sourceMessage, setSourceMessage] = useState('');
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

  useEffect(() => {
    let active = true;
    Promise.all([getCfaSourceCoverageMap(), getCfaSourceMapStatus()]).then(([coverage, status]) => {
      if (!active) return;
      setSourceCoverage(coverage);
      setSourceStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="page-container">
      <PageHeader
        badge="CONTENT QA"
        title="Content Operations"
        subtitle="Coverage, answer-key, duplicate-question, formula-reference, and curriculum-map validation for the local catalog."
      />

      <div className="grid-4 page-metrics">
        <MetricCard label="Levels" value={report.totals.levels ?? 1} detail={`${report.totals.topics} topics`} icon={FileSearch} />
        <MetricCard label="Questions" value={report.totals.questions} detail="Question bank rows" icon={ShieldCheck} tone="success" />
        <MetricCard label="Errors" value={report.totals.errors} detail="Must fix before release" icon={TriangleAlert} tone={hasErrors ? 'danger' : 'success'} />
        <MetricCard label="Exam-ready maps" value={curriculumReport.totals.examReadyTopics} detail={`${activeCurriculumWarnings} active warnings · 0 future diagnostics`} icon={CheckCircle2} tone={curriculumHasErrors ? 'danger' : activeCurriculumWarnings ? 'warning' : 'success'} />
      </div>

      <Panel tone="ops" title="Private CFA Source Coverage" className="ops-report-panel">
        <p className="muted-copy">
          Source Vault coverage is private and local: {sourceCoverage?.documentCount || 0} documents · {sourceCoverage?.chunkCount || 0} searchable chunks · {sourceStatus?.linkCount || 0} native links · standard release artifacts do not include source text.
        </p>
        <div className="action-row source-map-actions">
          <SourceLinkManager
            targets={curriculumReport.topics.map((topic) => ({
              kind: 'module',
              domain: 'cfa',
              level: topic.level,
              topicId: topic.id,
              title: topic.title,
              keywords: [topic.maturity, `${topic.objectives} objectives`, `${topic.formulas} formulas`],
              route: `/cfa/${topic.level}/${topic.id}`,
            }))}
            onRebuilt={(result) => {
              setSourceMessage(`Mapped ${result.links} source link(s) across ${result.targets} curriculum target(s).`);
              getCfaSourceMapStatus().then(setSourceStatus);
            }}
          />
          <SourceMapStatus />
        </div>
        {sourceMessage && <p className="muted-copy">{sourceMessage}</p>}
        <div className="coverage-grid">
          {['level1', 'level2', 'level3', 'prerequisite', 'reference'].map((level) => (
            <div key={`source:${level}`}>
              <strong>{level.replace('level', 'Level ')}</strong>
              <small>{sourceCoverage?.levelCounts?.[level] || 0} imported document(s)</small>
            </div>
          ))}
          <div>
            <strong><BookText size={16} /> Source policy</strong>
            <small><StatusBadge tone="success">private local only</StatusBadge> full text lives only in IndexedDB or ignored `.qvsource` bundles</small>
          </div>
        </div>
      </Panel>

      {releaseSections.map(({ title, release, progress, runtime, vignetteLabel, sprint }) => (
        <Panel key={release.id} tone="ops" title={title} className="ops-report-panel">
          <p className="muted-copy">
            {release.status} · {progress.examReadyTopics}/{progress.topicCount} topics exam-ready · {release.templateRowsRemaining} template rows remaining · {release.blockingIssues} blockers · {release.warnings} warnings · {progress.totalLessons} authored lessons · {progress.totalExamples} examples · {progress.totalQuestions} standalone questions · {progress.totalVignettes} {vignetteLabel} · {progress.totalFlashcards} flashcards · {progress.totalSkillLabs} mapped labs
          </p>
          <p className="muted-copy">
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
        </Panel>
      ))}

      <Panel tone="ops" title="Curriculum Authoring Map" className="ops-report-panel">
        <p className="muted-copy">
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
      </Panel>

      <Panel tone="ops" title="Content Batches" className="ops-report-panel">
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
      </Panel>

      <Panel tone="ops" title="CFA All-Level Coverage" className="ops-report-panel">
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
      </Panel>

      <Panel tone="ops" title="Issues">
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
          <p className="muted-copy">No content validation issues found.</p>
        )}
      </Panel>
    </div>
  );
}
