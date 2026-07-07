import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { getCfaTopicKey, loadCfaTopicContent } from './cfaLoaders';
import { useLevel3Pathway } from './useLevel3Pathway';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  ChevronRight,
  RotateCcw,
  Trophy,
  Target,
  BrainCircuit,
  CalendarClock,
  Calculator,
  ClipboardList,
} from 'lucide-react';
import { recordQuizAttempt, toggleBookmark } from '../../lib/learning';
import { explainWrongAnswer, getLlmSettings } from '../../lib/localLlm';
import { useProgressSummary } from '../../hooks/useProgress';
import { CommandHint, EmptyPanel, ProgressRail, QuestionStage, SegmentedControl, StatusBadge, Surface } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';
import AccessibleQuestionRunner from '../../components/a11y/AccessibleQuestionRunner';
import HandsFreeController from '../../components/a11y/HandsFreeController';

function currentTimestampMs() {
  return Date.now();
}

const quizModes = [
  { id: 'review-due', label: 'Review Due', icon: CalendarClock },
  { id: 'weak-areas', label: 'Weak Areas', icon: BrainCircuit },
  { id: 'topic-drill', label: 'Topic Drill', icon: Target },
  { id: 'mock-section', label: 'Mock Section', icon: ClipboardList },
  { id: 'formula-drill', label: 'Formula Drill', icon: Calculator },
];

const confidenceOptions = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const errorOptions = [
  { id: 'concept', label: 'Concept gap' },
  { id: 'calculation', label: 'Calculation' },
  { id: 'formula', label: 'Formula recall' },
  { id: 'ethics-judgment', label: 'Ethics judgment' },
  { id: 'misread', label: 'Misread' },
  { id: 'time-pressure', label: 'Time pressure' },
  { id: 'none', label: 'No error' },
];

function buildQuestionSet({ baseQuestions, mode, summary, topic, topicKey, objectiveParam }) {
  if (objectiveParam) {
    const objectiveQuestions = baseQuestions.filter((question) => question.learningObjective === objectiveParam);
    return { questions: objectiveQuestions.length ? objectiveQuestions : baseQuestions, usedFallback: objectiveQuestions.length === 0 };
  }

  if (mode === 'review-due') {
    const dueObjectives = new Set(
      summary.dueReviews
        .filter((item) => item.topic === topic || item.topic === topicKey)
        .map((item) => item.learningObjective),
    );
    const dueQuestions = baseQuestions.filter((question) => dueObjectives.has(question.learningObjective));
    return { questions: dueQuestions.length ? dueQuestions : baseQuestions, usedFallback: dueQuestions.length === 0 };
  }

  if (mode === 'weak-areas') {
    const weakObjectives = new Set(
      summary.weakObjectives
        .filter((item) => item.topic === topic || item.topic === topicKey)
        .map((item) => item.learningObjective),
    );
    const weakQuestions = baseQuestions.filter((question) => weakObjectives.has(question.learningObjective));
    return { questions: weakQuestions.length ? weakQuestions : baseQuestions, usedFallback: weakQuestions.length === 0 };
  }

  if (mode === 'formula-drill') {
    const formulaQuestions = baseQuestions.filter((question) => question.formula || question.tags?.includes('formula'));
    return { questions: formulaQuestions.length ? formulaQuestions : baseQuestions, usedFallback: formulaQuestions.length === 0 };
  }

  if (mode === 'mock-section') {
    const order = { foundation: 1, intermediate: 2, advanced: 3 };
    return {
      questions: [...baseQuestions].sort((a, b) => order[a.difficulty] - order[b.difficulty]).slice(0, 12),
      usedFallback: false,
    };
  }

  return { questions: baseQuestions, usedFallback: false };
}

function nextDefaultError(selected, correct) {
  return selected === correct ? 'none' : 'concept';
}

export default function CfaQuiz() {
  const { level, topic } = useParams();
  const [activePathway] = useLevel3Pathway();
  const [searchParams, setSearchParams] = useSearchParams();
  const summary = useProgressSummary();
  const mode = searchParams.get('mode') || 'topic-drill';
  const objectiveParam = searchParams.get('objective');
  const requestKey = `${level}:${topic}:${level === 'level3' ? activePathway : 'all'}`;
  const [contentState, setContentState] = useState({ key: null, data: null });
  const topicData = contentState.key === requestKey ? contentState.data : null;
  const loading = contentState.key !== requestKey;
  const topicKey = useMemo(() => getCfaTopicKey(level, topic), [level, topic]);
  const baseQuestions = useMemo(() => topicData?.questions || [], [topicData]);
  const objectives = useMemo(() => topicData?.learningObjectives || [], [topicData]);
  const objectiveById = useMemo(() => new Map(objectives.map((objective) => [objective.id, objective])), [objectives]);
  const { questions, usedFallback } = useMemo(
    () => buildQuestionSet({ baseQuestions, mode, summary, topic, topicKey, objectiveParam }),
    [baseQuestions, mode, objectiveParam, summary, topic, topicKey],
  );

  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [answers, setAnswers] = useState([]);
  const [startTime, setStartTime] = useState(currentTimestampMs);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [finished, setFinished] = useState(false);
  const [confidence, setConfidence] = useState('medium');
  const [errorCategory, setErrorCategory] = useState('none');
  // Map of question.id -> { state: 'loading'|'done'|'error', text?: string, error?: string }
  const [aiExplain, setAiExplain] = useState({});
  // A11Y-2: imperative handle to the accessible runner (used for focus control).
  const runnerRef = useRef(null);

  const safeCurrent = Math.min(current, Math.max(questions.length - 1, 0));
  const q = questions[safeCurrent];
  const letters = ['A', 'B', 'C', 'D'];
  const modeLabel = quizModes.find((item) => item.id === mode)?.label || 'Topic Drill';

  const score = useMemo(() => answers.filter((answer) => answer.correct).length, [answers]);

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

  function resetQuiz() {
    setCurrent(0);
    setSelected(null);
    setConfirmed(false);
    setAnswers([]);
    setFinished(false);
    setElapsedSeconds(0);
    setConfidence('medium');
    setErrorCategory('none');
    setStartTime(currentTimestampMs());
  }

  function handleModeChange(nextMode) {
    setSearchParams(nextMode === 'topic-drill' ? {} : { mode: nextMode });
    resetQuiz();
  }

  function handleSelect(idx) {
    if (confirmed) return;
    setSelected(idx);
  }

  function handleConfirm() {
    if (selected === null) return;
    setConfirmed(true);
    setConfidence(selected === q.correct ? 'high' : 'low');
    setErrorCategory(nextDefaultError(selected, q.correct));
  }

  useEffect(() => {
    function handleKeyboard(event) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(target.tagName)) return;
      if (!q || finished) return;
      const key = event.key.toLowerCase();
      const optionIndex = letters.findIndex((letter) => letter.toLowerCase() === key);
      if (!confirmed && optionIndex >= 0 && optionIndex < q.options.length) {
        event.preventDefault();
        handleSelect(optionIndex);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!confirmed) handleConfirm();
        else handleNext();
      }
    }

    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  });

  function buildAnswer() {
    const objective = objectiveById.get(q.learningObjective);
    return {
      domain: 'cfa',
      level,
      topic: topicKey,
      questionId: q.id,
      learningObjective: q.learningObjective,
      objectiveTitle: objective?.title || q.learningObjective,
      correct: selected === q.correct,
      confidence,
      errorCategory,
      difficulty: q.difficulty,
      selected,
      correctIndex: q.correct,
      formula: q.formula,
      path: `/cfa/${level}/${topic}/quiz?mode=${mode}`,
      itemType: mode === 'formula-drill' ? 'formula-drill' : mode === 'mock-section' ? 'mock-section' : q.itemType || 'single',
    };
  }

  function handleNext() {
    const nextAnswers = [...answers, buildAnswer()];
    setAnswers(nextAnswers);

    if (safeCurrent < questions.length - 1) {
      setCurrent(safeCurrent + 1);
      setSelected(null);
      setConfirmed(false);
      setConfidence('medium');
      setErrorCategory('none');
    } else {
      const elapsed = Math.round((currentTimestampMs() - startTime) / 1000);
      const finalScore = nextAnswers.filter((answer) => answer.correct).length;
      setElapsedSeconds(elapsed);
      recordQuizAttempt({
        domain: 'cfa',
        topic: topicKey,
        title: topicData?.title || topic,
        mode,
        score: finalScore,
        total: questions.length,
        elapsedSeconds: elapsed,
        answers: nextAnswers,
      });
      setFinished(true);
    }
  }

  async function handleExplainWithAi(question, answer) {
    const id = question.id;
    setAiExplain((map) => ({ ...map, [id]: { state: 'loading' } }));
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setAiExplain((map) => ({
          ...map,
          [id]: { state: 'error', error: 'Enable a local model in System Health → Local AI first.' },
        }));
        return;
      }
      const text = await explainWrongAnswer({
        settings,
        question: question.question,
        options: question.options,
        correctIndex: question.correct,
        userIndex: answer.selected,
        baseExplanation: question.explanation,
      });
      setAiExplain((map) => ({ ...map, [id]: { state: 'done', text } }));
    } catch (error) {
      setAiExplain((map) => ({
        ...map,
        [id]: { state: 'error', error: error instanceof Error ? error.message : 'Explanation failed.' },
      }));
    }
  }

  async function bookmarkQuestion(question) {
    await toggleBookmark({
      type: 'question',
      domain: 'cfa',
      moduleId: `${level}:${topic}`,
      questionId: question.id,
      title: question.question,
      path: `/cfa/${level}/${topic}/quiz?mode=${mode}`,
    });
  }

  function sourceTargetForQuestion(question) {
    const objective = objectiveById.get(question.learningObjective);
    return {
      kind: 'question',
      domain: 'cfa',
      level,
      topicId: topic,
      pathway: level === 'level3' ? activePathway : undefined,
      title: question.question,
      objectiveIds: [question.learningObjective],
      formulaNames: question.formula ? [question.formula] : [],
      keywords: [objective?.title, question.explanation, question.difficulty, mode].filter(Boolean),
      route: `/cfa/${level}/${topic}/quiz?mode=${mode}`,
    };
  }

  if (loading) {
    return (
      <div className="page-container" aria-busy="true">
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-card" />
      </div>
    );
  }

  if (!questions.length) {
    return (
      <div className="page-container">
        <EmptyPanel
          title="Quiz Coming Soon"
          description="Questions for this topic are being developed."
          tone="exam"
          action={<Link to="/cfa" className="btn btn-primary">Back to CFA</Link>}
        />
      </div>
    );
  }

  if (finished) {
    const pct = Math.round((score / questions.length) * 100);
    const missed = answers.filter((answer) => !answer.correct);

    return (
      <div className="page-container">
        <div className="quiz-container">
          <Surface className="quiz-result-panel animate-scale">
            <div style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              margin: '0 auto var(--space-6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: pct >= 70 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
            }}>
              <Trophy size={36} color={pct >= 70 ? 'var(--success)' : 'var(--danger)'} />
            </div>
            <h2 style={{ fontSize: 'var(--fs-3xl)', fontWeight: 800, marginBottom: 'var(--space-2)' }}>
              {pct >= 70 ? 'Strong pass' : pct >= 50 ? 'Useful reps logged' : 'Review queue updated'}
            </h2>
            <p className="qv-text-secondary" style={{ marginBottom: 'var(--space-8)' }}>
              {topicData?.title || topic} - {modeLabel}
            </p>

            <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-8)', marginBottom: 'var(--space-8)', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800, color: pct >= 70 ? 'var(--success)' : 'var(--danger)' }}>{pct}%</div>
                <div className="qv-fs-sm qv-text-muted">Score</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800 }}>{score}/{questions.length}</div>
                <div className="qv-fs-sm qv-text-muted">Correct</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800 }}>{missed.length}</div>
                <div className="qv-fs-sm qv-text-muted">Scheduled weak reps</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800 }}>{elapsedSeconds}s</div>
                <div className="qv-fs-sm qv-text-muted">Time</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-4)', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={resetQuiz}>
                <RotateCcw size={16} /> Retry Mode
              </button>
              <Link to={`/cfa/${level}/${topic}`} className="btn btn-primary">
                <ArrowLeft size={16} /> Back to Module
              </Link>
            </div>
          </Surface>

          <Surface className="quiz-answer-review">
            <div className="flex-between" style={{ marginBottom: 'var(--space-4)' }}>
              <h3 className="qv-m-0">Answer Review</h3>
              <span className="badge badge-blue">{missed.length ? 'Missed questions first' : 'Clean run'}</span>
            </div>
            {[...answers]
              .sort((a, b) => Number(a.correct) - Number(b.correct))
              .map((answer, index) => {
                const question = questions.find((item) => item.id === answer.questionId);
                const objective = objectiveById.get(answer.learningObjective);
                if (!question) return null;
                return (
                  <div
                    key={`${answer.questionId}-${index}`}
                    style={{
                      borderTop: index ? '1px solid var(--border)' : 0,
                      paddingTop: index ? 'var(--space-4)' : 0,
                      marginTop: index ? 'var(--space-4)' : 0,
                    }}
                  >
                    <div className="qv-row-3-start">
                      {answer.correct ? <CheckCircle2 size={18} color="var(--success)" /> : <XCircle size={18} color="var(--danger)" />}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700 }}>{question.question}</div>
                        <div className="qv-text-secondary qv-fs-sm qv-mt-2">
                          Your answer: {letters[answer.selected]} · Correct answer: {letters[answer.correctIndex]} · Confidence: {answer.confidence} · Error: {answer.errorCategory}
                        </div>
                        <p className="qv-text-secondary qv-fs-sm" style={{ lineHeight: 1.6 }}>{question.explanation}</p>
                        <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
                          <span className="badge badge-purple">{objective?.title || answer.learningObjective}</span>
                          {question.formula && <span className="badge badge-blue">Formula: {question.formula}</span>}
                          <Link to={`/cfa/${level}/${topic}`} className="btn btn-secondary" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                            Related lesson
                          </Link>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: 'var(--space-2) var(--space-3)' }}
                            onClick={() => bookmarkQuestion(question)}
                          >
                            Bookmark
                          </button>
                          {!answer.correct && (
                            <button
                              className="btn btn-secondary"
                              style={{ padding: 'var(--space-2) var(--space-3)' }}
                              onClick={() => handleExplainWithAi(question, answer)}
                              disabled={aiExplain[question.id]?.state === 'loading'}
                            >
                              {aiExplain[question.id]?.state === 'loading' ? 'Thinking…' : '🤖 Explain with AI'}
                            </button>
                          )}
                        </div>
                        {aiExplain[question.id]?.state === 'done' && (
                          <p style={{ borderLeft: '3px solid var(--accent)', padding: 'var(--space-2) var(--space-3)', margin: 'var(--space-2) 0 0', background: 'var(--surface-2, rgba(120,180,255,0.06))', borderRadius: 'var(--radius-md, 8px)', whiteSpace: 'pre-line' }}>
                            {aiExplain[question.id].text}
                          </p>
                        )}
                        {aiExplain[question.id]?.state === 'error' && (
                          <p className="qv-text-danger qv-fs-sm" style={{ margin: 'var(--space-2) 0 0' }}>
                            {aiExplain[question.id].error}
                          </p>
                        )}
                        <SourceRail
                          compact
                          limit={2}
                          title="Question Source Context"
                          target={sourceTargetForQuestion(question)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
          </Surface>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <Link to={`/cfa/${level}/${topic}`} className="qv-row-2 qv-text-secondary qv-fs-sm" style={{ display: 'inline-flex', marginBottom: 'var(--space-6)' }}>
        <ArrowLeft size={16} /> Back to {topicData?.title || topic}
      </Link>

      <div className="quiz-container">
        <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-5)' }}>
          <SegmentedControl
            label="Quiz mode"
            options={quizModes.map((item) => ({ value: item.id, label: item.label, icon: item.icon }))}
            value={mode}
            onChange={handleModeChange}
            density="compact"
          />
          {usedFallback && (
            <p className="qv-text-muted qv-fs-sm" style={{ margin: 'var(--space-3) 0 0' }}>
              No targeted items are currently queued for this mode, so the full topic bank is loaded.
            </p>
          )}
        </Surface>

        <div className="quiz-header">
          <div>
            <div style={{ fontWeight: 700 }}>{topicData?.title || topic}</div>
            <div className="qv-fs-xs qv-text-muted">Level {level?.toUpperCase()} · {modeLabel}</div>
          </div>
          <div className="qv-row-4">
            <span className={`badge ${q.difficulty === 'foundation' ? 'badge-green' : q.difficulty === 'intermediate' ? 'badge-blue' : 'badge-purple'}`}>
              {q.difficulty?.toUpperCase()}
            </span>
            <span className="qv-fs-sm qv-fw-semibold">
              {safeCurrent + 1} / {questions.length}
            </span>
          </div>
        </div>

        <ProgressRail
          value={safeCurrent + (confirmed ? 1 : 0)}
          max={questions.length}
          label="Question progress"
          detail={`${safeCurrent + 1}/${questions.length}`}
          tone="exam"
        />

        <QuestionStage
          key={`${mode}-${safeCurrent}`}
          badge={q.difficulty?.toUpperCase()}
          objective={objectiveById.get(q.learningObjective)?.title || q.learningObjective}
          question={q.question}
          status={confirmed ? (selected === q.correct ? 'success' : 'danger') : 'exam'}
          footer={<CommandHint keys={['A-D', 'Enter']} label="select and confirm" />}
        >

          {/* A11Y-3: hands-free study controls. Untimed quiz, so a voice answer
              applies directly (testMode={false}); read-aloud uses local TTS. The
              strip self-hides when the browser lacks speech APIs. */}
          {!confirmed && (
            <HandsFreeController
              question={q.question}
              options={q.options.map((opt, idx) => ({ letter: letters[idx], text: opt }))}
              onSelect={handleSelect}
              testMode={false}
              preface={`Question ${safeCurrent + 1} of ${questions.length}.`}
            />
          )}

          {/* A11Y-2: the shared accessible radiogroup primitive replaces the
              hand-rolled <button> list. Selection/confirmation stay controlled
              here, so scoring/persistence/analytics are unchanged. The runner
              also renders the correct/incorrect headline + explanation via its
              aria-live region; the formula badge, source rail and confidence/
              error controls follow as its children below that feedback. */}
          <AccessibleQuestionRunner
            ref={runnerRef}
            groupLabel="Answer options"
            question={q.question}
            hideStem
            options={q.options.map((opt, idx) => ({ id: idx, text: opt }))}
            selectedIndex={selected}
            onSelect={handleSelect}
            confirmed={confirmed}
            correctIndex={q.correct}
            explanation={confirmed ? q.explanation : undefined}
            letters={letters}
          >
            {confirmed && (
              <div className="quiz-explanation">
                {q.formula && <StatusBadge tone="accent" style={{ marginTop: 'var(--space-3)' }}>Related formula: {q.formula}</StatusBadge>}
                <SourceRail
                  compact
                  limit={2}
                  title="Source Context"
                  subtitle="Shown after confirmation only."
                  target={sourceTargetForQuestion(q)}
                />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
                  <div>
                    <div className="qv-fs-xs qv-text-muted qv-mb-2 qv-fw-bold">
                      CONFIDENCE
                    </div>
                    <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
                      {confidenceOptions.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`btn ${confidence === item.id ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => setConfidence(item.id)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label style={{ display: 'block' }}>
                    <span className="qv-fs-xs qv-text-muted qv-mb-2 qv-fw-bold" style={{ display: 'block' }}>
                      ERROR TYPE
                    </span>
                    <select
                      value={errorCategory}
                      onChange={(event) => setErrorCategory(event.target.value)}
                      style={{
                        width: '100%',
                        minHeight: 44,
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text-primary)',
                        padding: '0 var(--space-3)',
                      }}
                    >
                      {errorOptions
                        .filter((item) => q.errorCategories?.includes(item.id) || item.id === 'none')
                        .map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                    </select>
                  </label>
                </div>
              </div>
            )}
          </AccessibleQuestionRunner>
        </QuestionStage>

        <div className="qv-row-3" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-6)' }}>
          {!confirmed ? (
            <button className="btn btn-primary btn-lg" onClick={handleConfirm} disabled={selected === null} style={{ opacity: selected === null ? 0.5 : 1 }}>
              Confirm Answer
            </button>
          ) : (
            <button className="btn btn-primary btn-lg" onClick={handleNext}>
              {safeCurrent < questions.length - 1 ? (
                <>Next Question <ChevronRight size={16} /></>
              ) : (
                <>View Results <Trophy size={16} /></>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
