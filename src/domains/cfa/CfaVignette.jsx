import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Layers, Trophy } from 'lucide-react';
import { getCfaTopicKey, loadCfaTopicContent } from './cfaLoaders';
import { useLevel3Pathway } from './useLevel3Pathway';
import { CaseViewer, CommandHint, EmptyPanel, MetricCard, PageHeader, QuestionStage, StatusBadge } from '../../components/ui/Primitives';
import { recordVignetteAttempt } from '../../lib/learning';
import { SourceRail } from '../../components/SourceContext';

function nowMs() {
  return Date.now();
}

export default function CfaVignette() {
  const { level, topic } = useParams();
  const [activePathway] = useLevel3Pathway();
  const requestKey = `${level}:${topic}:${level === 'level3' ? activePathway : 'all'}`;
  const [contentState, setContentState] = useState({ key: null, data: null });
  const data = contentState.key === requestKey ? contentState.data : null;
  const loading = contentState.key !== requestKey;
  const topicKey = useMemo(() => getCfaTopicKey(level, topic), [level, topic]);
  const [vignetteIndex, setVignetteIndex] = useState(0);
  const [selected, setSelected] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [startTime, setStartTime] = useState(nowMs);
  const vignette = data?.vignettes?.[vignetteIndex];
  const letters = ['A', 'B', 'C', 'D'];

  useEffect(() => {
    let cancelled = false;
    loadCfaTopicContent(level, topic, level === 'level3' ? { pathway: activePathway } : {})
      .then((content) => {
        if (!cancelled) setContentState({ key: requestKey, data: content });
      })
      .catch(() => {
        if (!cancelled) setContentState({ key: requestKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activePathway, level, requestKey, topic]);

  useEffect(() => {
    function handleKeyboard(event) {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.ctrlKey && event.key === 'Enter' && !submitted && vignette && Object.keys(selected).length === vignette.questions.length) {
        event.preventDefault();
        submit();
      }
    }

    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  });

  if (loading) {
    return (
      <div className="page-container" aria-busy="true">
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-card" />
      </div>
    );
  }

  if (!data || !vignette) {
    return (
      <div className="page-container">
        <EmptyPanel title="No vignette set is available for this topic yet." tone="exam" />
      </div>
    );
  }

  const score = vignette.questions.filter((question) => selected[question.id] === question.correct).length;
  const pct = Math.round((score / vignette.questions.length) * 100);

  async function submit() {
    const elapsedSeconds = Math.round((nowMs() - startTime) / 1000);
    await recordVignetteAttempt({
      domain: 'cfa',
      level,
      topic: topicKey,
      vignetteId: vignette.id,
      title: vignette.title,
      score,
      total: vignette.questions.length,
      elapsedSeconds,
      answers: vignette.questions.map((question) => ({
        domain: 'cfa',
        level,
        topic: topicKey,
        questionId: question.id,
        learningObjective: question.learningObjective,
        objectiveTitle: question.learningObjective,
        correct: selected[question.id] === question.correct,
        confidence: selected[question.id] === question.correct ? 'medium' : 'low',
        errorCategory: selected[question.id] === question.correct ? 'none' : 'concept',
        difficulty: question.difficulty,
        selected: selected[question.id],
        correctIndex: question.correct,
        formula: question.formula,
        path: `/cfa/${level}/${topic}/vignette`,
        itemType: 'vignette',
      })),
    });
    setSubmitted(true);
  }

  function nextSet() {
    setVignetteIndex((value) => (value + 1) % data.vignettes.length);
    setSelected({});
    setSubmitted(false);
    setStartTime(nowMs());
  }

  return (
    <div className="page-container">
      <Link to={`/cfa/${level}/${topic}`} className="back-link">
        <ArrowLeft size={16} /> Back to {data.title}
      </Link>
      <PageHeader
        badge={data.runtimeMode === 'exam-ready' ? 'EXAM-READY' : level?.replace('level', 'LEVEL ')}
        title={vignette.title}
        subtitle={
          data.runtimeMode === 'exam-ready'
            ? 'Editorial item-set content is available locally with reviewed exhibits, rationales, and provenance.'
            : 'A local item-set vignette. Read the case once, answer all questions, then review the explanation trail.'
        }
      />

      <div className="grid-3" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Set" value={`${vignetteIndex + 1}/${data.vignettes.length}`} detail={data.title} icon={Layers} />
        <MetricCard label="Questions" value={vignette.questions.length} detail="Item-set prompts" icon={CheckCircle2} tone="success" />
        <MetricCard label="Score" value={submitted ? `${pct}%` : '-'} detail={submitted ? `${score}/${vignette.questions.length}` : 'Submit to score'} icon={Trophy} tone="warning" />
      </div>

      <CaseViewer title="Case Facts" exhibits={vignette.exhibits || []}>
        <p>{vignette.stem}</p>
      </CaseViewer>

      {submitted && (
        <SourceRail
          title="Vignette Source Context"
          subtitle="Private snippets appear after submission and are mapped to the case, objectives, and item-set explanations."
          target={{
            kind: 'vignette',
            domain: 'cfa',
            level,
            topicId: topic,
            pathway: level === 'level3' ? activePathway : undefined,
            title: vignette.title,
            objectiveIds: vignette.objectiveIds || vignette.questions.map((question) => question.learningObjective),
            formulaNames: vignette.questions.map((question) => question.formula).filter(Boolean),
            keywords: [vignette.stem, ...vignette.questions.map((question) => `${question.question} ${question.explanation}`)],
            route: `/cfa/${level}/${topic}/vignette`,
          }}
          limit={3}
          compact
        />
      )}

      <div className="quiz-container" style={{ marginTop: 'var(--space-6)' }}>
        {vignette.questions.map((question, index) => (
          <QuestionStage
            key={question.id}
            badge={`Question ${index + 1}`}
            objective={question.learningObjective}
            question={question.question}
            status={submitted ? (selected[question.id] === question.correct ? 'success' : 'danger') : 'exam'}
            footer={!submitted && index === 0 ? <CommandHint keys="Ctrl+Enter" label="submit once complete" /> : null}
          >
            <div className="quiz-options">
              {question.options.map((option, optionIndex) => {
                const picked = selected[question.id] === optionIndex;
                const correct = submitted && optionIndex === question.correct;
                const missed = submitted && picked && optionIndex !== question.correct;
                return (
                  <button
                    key={option}
                    type="button"
                    className={`quiz-option ${picked ? 'selected' : ''} ${correct ? 'correct' : ''} ${missed ? 'incorrect' : ''}`}
                    disabled={submitted}
                    onClick={() => setSelected((existing) => ({ ...existing, [question.id]: optionIndex }))}
                  >
                    <span className="quiz-option-letter">{letters[optionIndex]}</span>
                    <span style={{ textAlign: 'left' }}>{option}</span>
                  </button>
                );
              })}
            </div>
            {submitted && (
              <div className="quiz-explanation">
                <StatusBadge tone={selected[question.id] === question.correct ? 'success' : 'danger'}>
                  {selected[question.id] === question.correct ? 'Correct' : 'Review'}
                </StatusBadge>
                <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-3)' }}>{question.explanation}</p>
              </div>
            )}
          </QuestionStage>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {submitted ? (
          <button className="btn btn-primary" onClick={nextSet}>Next Vignette</button>
        ) : (
          <button className="btn btn-primary" onClick={submit} disabled={Object.keys(selected).length !== vignette.questions.length}>
            Submit Vignette
          </button>
        )}
      </div>
    </div>
  );
}
