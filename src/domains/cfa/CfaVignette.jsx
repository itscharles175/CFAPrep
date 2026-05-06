import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Layers, Trophy } from 'lucide-react';
import { getCfaTopicKey, loadCfaTopicContent } from './cfaLoaders';
import { PageHeader, MetricCard } from '../../components/ui/Primitives';
import { recordVignetteAttempt } from '../../lib/learning';

function nowMs() {
  return Date.now();
}

export default function CfaVignette() {
  const { level, topic } = useParams();
  const requestKey = `${level}:${topic}`;
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
    loadCfaTopicContent(level, topic)
      .then((content) => {
        if (!cancelled) setContentState({ key: requestKey, data: content });
      })
      .catch(() => {
        if (!cancelled) setContentState({ key: requestKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [level, requestKey, topic]);

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
        <div className="glass-card no-hover">No vignette set is available for this topic yet.</div>
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

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h2 style={{ marginTop: 0 }}>Case Facts</h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{vignette.stem}</p>
      </div>

      <div className="quiz-container">
        {vignette.questions.map((question, index) => (
          <div key={question.id} className="glass-card no-hover" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="badge badge-purple">Question {index + 1}</span>
            <h3>{question.question}</h3>
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
            {submitted && <p style={{ color: 'var(--text-secondary)' }}>{question.explanation}</p>}
          </div>
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
