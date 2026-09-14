import type { StudyContext } from '../../lib/studyContext';
import { LEVEL3_PATHWAY_OPTIONS, type Level3Pathway } from '../../domains/cfa/cfaLevel3Pathways';

interface StudyContextSelectorProps {
  context: StudyContext;
  pathway: Level3Pathway;
  onContextChange: (patch: Partial<StudyContext>) => void;
  onPathwayChange: (pathway: string) => void;
}

export default function StudyContextSelector({
  context,
  pathway,
  onContextChange,
  onPathwayChange,
}: StudyContextSelectorProps) {
  const domainLabel = context.domain === 'cfa' ? 'CFA' : context.domain === 'lsat' ? 'LSAT' : context.domain === 'quant' ? 'Quant' : 'Excel';
  const levelLabel = context.cfaLevel === 'level1' ? 'Level I' : context.cfaLevel === 'level2' ? 'Level II' : 'Level III';
  const goalLabel = context.goal === 'exam-readiness'
    ? 'Exam readiness'
    : context.goal === 'skill-building'
      ? 'Skill building'
      : context.goal === 'retention'
        ? 'Retention'
        : 'Balanced';

  return (
    <details className="study-context-selector">
      <summary aria-label={`Study context: ${domainLabel}${context.domain === 'cfa' ? `, ${levelLabel}` : ''}, ${goalLabel}`}>
        <span className="study-context-kicker">Study context</span>
        <strong>{domainLabel}{context.domain === 'cfa' ? ` · ${levelLabel}` : ''}</strong>
        <span className="study-context-goal">{goalLabel}</span>
      </summary>
      <div className="study-context-fields" aria-label="Study context controls">
        <label>
          <span>Track</span>
          <select value={context.domain} onChange={(event) => onContextChange({ domain: event.target.value as StudyContext['domain'] })}>
            <option value="cfa">CFA</option>
            <option value="lsat">LSAT</option>
            <option value="quant">Quant</option>
            <option value="excel">Excel</option>
          </select>
        </label>

        {context.domain === 'cfa' && (
          <label>
            <span>Level</span>
            <select value={context.cfaLevel} onChange={(event) => onContextChange({ cfaLevel: event.target.value as StudyContext['cfaLevel'] })}>
              <option value="level1">Level I</option>
              <option value="level2">Level II</option>
              <option value="level3">Level III</option>
            </select>
          </label>
        )}

        {context.domain === 'cfa' && context.cfaLevel === 'level3' && (
          <label>
            <span>Pathway</span>
            <select value={pathway} onChange={(event) => onPathwayChange(event.target.value)}>
              {LEVEL3_PATHWAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span>Goal</span>
          <select value={context.goal} onChange={(event) => onContextChange({ goal: event.target.value as StudyContext['goal'] })}>
            <option value="balanced">Balanced plan</option>
            <option value="exam-readiness">Exam readiness</option>
            <option value="retention">Retention</option>
            <option value="skill-building">Skill building</option>
          </select>
        </label>
      </div>
    </details>
  );
}
