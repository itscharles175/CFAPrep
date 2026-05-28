import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, Flag, ListChecks, PenLine, Timer, Trophy } from 'lucide-react';
import { loadCfaLevelContent, loadCfaMockExam } from '../domains/cfa/cfaLoaders';
import { LEVEL3_PATHWAY_OPTIONS } from '../domains/cfa/cfaLevel3Pathways';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { CaseViewer, EmptyPanel, InlineCluster, MetricCard, PageHeader, Panel, ProgressRail, QuestionStage, RubricPanel, SegmentedControl, StatusBadge, Surface } from '../components/ui/Primitives';
import {
  clearMockSectionState,
  getMockSectionState,
  recordConstructedResponseAttempt,
  recordMockAttempt,
  saveMockSectionState,
} from '../lib/learning';
import { SourceRail } from '../components/SourceContext';
import { explainWrongAnswer, getLlmSettings } from '../lib/localLlm';
import { generateMockExam, getCachedGeneratedMock, saveCachedGeneratedMock, toSyntheticMockContent } from '../lib/mockGenerator';

function nowMs() {
  return Date.now();
}

function itemTitle(item) {
  if (item.type === 'question') return item.question.question;
  if (item.type === 'vignette') return item.vignette.title;
  return item.constructed.title;
}

function itemTopic(item) {
  if (item.type === 'question') return item.question.topic;
  if (item.type === 'vignette') return item.vignette.topic;
  return item.constructed.topic;
}

function itemId(item) {
  if (item.type === 'question') return item.question.id;
  if (item.type === 'vignette') return item.vignette.id;
  return item.constructed.id;
}

function buildMockItems(level, levelContent, mock) {
  const questionsById = new Map(
    levelContent.topics
      .flatMap((topic) => topic.questions)
      .map((question) => [question.id, question]),
  );
  const vignettesById = new Map(levelContent.topics.flatMap((topic) => topic.vignettes).map((vignette) => [vignette.id, vignette]));
  const constructedById = new Map(levelContent.constructedResponses.map((item) => [item.id, item]));

  const standalone = mock.questionIds.map((questionId) => questionsById.get(questionId)).filter(Boolean).map((question) => ({ type: 'question', question }));
  const vignettes = (mock.vignetteIds || []).map((vignetteId) => vignettesById.get(vignetteId)).filter(Boolean).map((vignette) => ({ type: 'vignette', vignette }));
  const constructed = (mock.constructedResponseIds || [])
    .map((constructedId) => constructedById.get(constructedId))
    .filter(Boolean)
    .map((item) => ({ type: 'constructed-response', constructed: item }));

  if (level === 'level1') return [...standalone, ...vignettes.slice(0, 2)];
  if (level === 'level2') return [...vignettes, ...standalone.slice(0, 6)];
  return [...constructed, ...vignettes, ...standalone.slice(0, 4)];
}

function downloadMockSummary(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-mock-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function questionRowsFromItem(item) {
  if (item.type === 'question') return [item.question];
  if (item.type === 'vignette') return item.vignette.questions;
  return [];
}

function MockQuestion({ question, selected, submitted = false, onSelect }) {
  const letters = ['A', 'B', 'C', 'D'];
  return (
    <QuestionStage
      badge={question.difficulty}
      objective={question.learningObjective}
      question={question.question}
      status={submitted ? (selected === question.correct ? 'success' : 'danger') : 'exam'}
    >
      <div className="quiz-options">
        {question.options.map((option, index) => {
          const picked = selected === index;
          const correct = submitted && index === question.correct;
          const missed = submitted && picked && index !== question.correct;
          return (
            <button
              key={option}
              type="button"
              className={`quiz-option ${picked ? 'selected' : ''} ${correct ? 'correct' : ''} ${missed ? 'incorrect' : ''}`}
              disabled={submitted}
              onClick={() => onSelect(index)}
            >
              <span className="quiz-option-letter">{letters[index]}</span>
              <span style={{ textAlign: 'left' }}>{option}</span>
            </button>
          );
        })}
      </div>
      {submitted && <p style={{ color: 'var(--text-secondary)' }}>{question.explanation}</p>}
    </QuestionStage>
  );
}

function ConstructedItem({ item, response, scores, onResponse, onScore }) {
  return (
    <Surface tone="study" status="exam">
      <StatusBadge tone="exam">Constructed Response</StatusBadge>
      <h2>{item.title}</h2>
      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.prompt}</p>
      <textarea
        aria-label={`${item.title} response`}
        value={response || ''}
        onChange={(event) => onResponse(event.target.value)}
        placeholder="Write a concise bullet response..."
        style={{ width: '100%', minHeight: 180, resize: 'vertical', marginTop: 'var(--space-4)' }}
      />
      <div style={{ marginTop: 'var(--space-5)' }}>
        <RubricPanel
          title={item.rubric.title}
          criteria={item.rubric.criteria}
          scores={scores || {}}
          maxPoints={item.rubric.maxPoints}
          onScore={onScore}
        />
      </div>
      <details style={{ marginTop: 'var(--space-5)' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Model answer</summary>
        <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-3)' }}>{item.modelAnswer}</p>
      </details>
    </Surface>
  );
}

export default function MockExam() {
  const params = useParams();
  const level = params.level || 'level1';
  const [activePathway, setActivePathway] = useLevel3Pathway();
  const [contentState, setContentState] = useState({ level: null, pathway: null, levelContent: null, mock: null });
  const [mode, setMode] = useState('blueprint');
  const [generatedMock, setGeneratedMock] = useState(null);
  const [genState, setGenState] = useState('idle');
  const genAbortRef = useRef(null);
  const [genError, setGenError] = useState('');
  const [genProgress, setGenProgress] = useState(null);
  // Map of question.id -> { state: 'loading'|'done'|'error', text?: string, error?: string }
  const [mockAiExplain, setMockAiExplain] = useState({});
  const mockAiAbortRef = useRef(null);
  const contentMatches = contentState.level === level && (level !== 'level3' || contentState.pathway === activePathway);
  // A generated mock is shaped into the same { levelContent, mock, items } the
  // runner understands, so scoring/timing/persistence work unchanged.
  const generatedView = useMemo(
    () => (mode === 'generated' ? toSyntheticMockContent(generatedMock) : null),
    [mode, generatedMock],
  );
  const levelContent = generatedView ? generatedView.levelContent : contentMatches ? contentState.levelContent : null;
  const mock = generatedView ? generatedView.mock : contentMatches ? contentState.mock : null;
  const loading = !generatedView && !contentMatches;
  const items = useMemo(
    () => (generatedView ? generatedView.items : levelContent && mock ? buildMockItems(level, levelContent, mock) : []),
    [generatedView, level, levelContent, mock],
  );
  const objectiveMap = useMemo(
    () => new Map((levelContent?.topics || []).flatMap((topic) => topic.learningObjectives).map((objective) => [objective.id, objective])),
    [levelContent],
  );
  const topicTitleMap = useMemo(() => new Map((levelContent?.topics || []).map((topic) => [topic.topic, topic.title])), [levelContent]);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState({});
  const [constructedResponses, setConstructedResponses] = useState({});
  const [rubricScores, setRubricScores] = useState({});
  const [flags, setFlags] = useState(new Set());
  const [startTime, setStartTime] = useState(nowMs);
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState(null);
  const [pausedMs, setPausedMs] = useState(0);
  const [finished, setFinished] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [report, setReport] = useState(null);
  const mockStateId = `${level === 'level3' ? `cfa-${level}-${activePathway}-mixed-mock` : `cfa-${level}-mixed-mock`}${generatedView ? '-generated' : ''}`;
  const item = items[current];
  const questionRows = useMemo(() => items.flatMap(questionRowsFromItem), [items]);
  const constructedItems = useMemo(() => items.filter((mockItem) => mockItem.type === 'constructed-response').map((mockItem) => mockItem.constructed), [items]);
  const answeredQuestions = questionRows.filter((question) => selected[question.id] !== undefined).length;
  const answeredConstructed = constructedItems.filter((constructed) => constructedResponses[constructed.id]?.trim()).length;
  const answered = answeredQuestions + answeredConstructed;
  const score = questionRows.filter((question) => selected[question.id] === question.correct).length;
  const unansweredItems = items.filter((mockItem) => {
    if (mockItem.type === 'constructed-response') return !constructedResponses[mockItem.constructed.id]?.trim();
    return questionRowsFromItem(mockItem).some((question) => selected[question.id] === undefined);
  });

  useEffect(() => {
    let cancelled = false;
    const pathwayOptions = level === 'level3' ? { pathway: activePathway } : {};
    Promise.all([loadCfaLevelContent(level, pathwayOptions), loadCfaMockExam(level, undefined, pathwayOptions)])
      .then(([content, loadedMock]) => {
        if (!cancelled) setContentState({ level, pathway: level === 'level3' ? activePathway : null, levelContent: content, mock: loadedMock });
      })
      .catch(() => {
        if (!cancelled) setContentState({ level, pathway: level === 'level3' ? activePathway : null, levelContent: null, mock: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activePathway, level]);

  // Load any previously generated mock for this level so it survives reloads.
  useEffect(() => {
    let cancelled = false;
    getCachedGeneratedMock(level).then((cached) => {
      if (!cancelled) setGeneratedMock(cached || null);
    });
    return () => {
      cancelled = true;
    };
  }, [level]);

  async function handleGenerateMock() {
    setGenState('loading');
    setGenError('');
    setGenProgress(null);
    const controller = new AbortController();
    genAbortRef.current = controller;
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setGenState('error');
        setGenError('Enable a local model in System Health → Local AI to generate a mock from your curriculum.');
        return;
      }
      const topics = (contentState.levelContent?.topics || []).map((topic) => ({ topic: topic.topic, title: topic.title }));
      const generated = await generateMockExam({
        level,
        topics,
        settings,
        signal: controller.signal,
        onProgress: (progress) => setGenProgress(progress),
      });
      if (controller.signal.aborted) {
        setGenState('cancelled');
        return;
      }
      await saveCachedGeneratedMock(level, generated);
      setGeneratedMock(generated);
      setMode('generated');
      setGenState('done');
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        setGenState('cancelled');
      } else {
        setGenState('error');
        setGenError(error instanceof Error ? error.message : 'Mock generation failed.');
      }
    } finally {
      genAbortRef.current = null;
    }
  }

  function handleCancelGenerateMock() {
    genAbortRef.current?.abort();
  }

  async function handleMockExplainWithAi(question, picked, correctIndex) {
    const id = question.id;
    setMockAiExplain((map) => ({ ...map, [id]: { state: 'loading' } }));
    const controller = new AbortController();
    mockAiAbortRef.current = controller;
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setMockAiExplain((map) => ({
          ...map,
          [id]: { state: 'error', error: 'Enable a local model in System Health → Local AI first.' },
        }));
        return;
      }
      const text = await explainWrongAnswer({
        settings,
        question: question.question,
        options: question.options,
        correctIndex,
        userIndex: picked,
        baseExplanation: question.explanation,
        signal: controller.signal,
      });
      setMockAiExplain((map) => ({ ...map, [id]: { state: 'done', text } }));
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        setMockAiExplain((map) => ({ ...map, [id]: { state: 'error', error: 'Explanation cancelled.' } }));
      } else {
        setMockAiExplain((map) => ({
          ...map,
          [id]: { state: 'error', error: error instanceof Error ? error.message : 'Explanation failed.' },
        }));
      }
    } finally {
      mockAiAbortRef.current = null;
    }
  }

  useEffect(() => {
    let active = true;
    getMockSectionState(mockStateId).then((state) => {
      if (!active) return;
      if (state?.questionIds?.join('|') === items.map(itemId).join('|')) {
        setSelected(state.selected || {});
        setConstructedResponses(state.constructedResponses || {});
        setRubricScores(state.rubricScores || {});
        setFlags(new Set(state.flaggedQuestionIds || []));
        setCurrent(Math.min(state.currentIndex || 0, items.length - 1));
        setStartTime(state.startTime || nowMs());
        setPausedMs(state.pausedMs || 0);
        setPaused(state.status === 'paused');
        setPausedAt(state.pausedAt || null);
      }
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [items, mockStateId]);

  useEffect(() => {
    if (!hydrated || finished || !items.length || !mock) return;
    saveMockSectionState({
      id: mockStateId,
      title: mock.title,
      questionIds: items.map(itemId),
      selected,
      constructedResponses,
      rubricScores,
      flaggedQuestionIds: [...flags],
      currentIndex: current,
      startTime,
      pausedMs,
      pausedAt,
      status: paused ? 'paused' : 'in-progress',
    });
  }, [constructedResponses, current, flags, finished, hydrated, items, level, mock, mockStateId, paused, pausedAt, pausedMs, rubricScores, selected, startTime]);

  useEffect(() => {
    function handleKeyboard(event) {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (paused || finished || !items.length) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setCurrent((value) => Math.min(items.length - 1, value + 1));
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setCurrent((value) => Math.max(0, value - 1));
      }
      if (event.key.toLowerCase() === 'f' && item) {
        event.preventDefault();
        toggleFlag();
      }
    }

    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  });

  function toggleFlag() {
    const id = itemId(item);
    setFlags((existing) => {
      const next = new Set(existing);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function restart() {
    setCurrent(0);
    setSelected({});
    setConstructedResponses({});
    setRubricScores({});
    setFlags(new Set());
    setFinished(false);
    setElapsedSeconds(0);
    setStartTime(nowMs());
    setPaused(false);
    setPausedAt(null);
    setPausedMs(0);
    setReviewMode(false);
    setReport(null);
    clearMockSectionState(mockStateId);
  }

  function togglePause() {
    if (paused) {
      setPausedMs((value) => value + (nowMs() - pausedAt));
      setPaused(false);
      setPausedAt(null);
    } else {
      setPaused(true);
      setPausedAt(nowMs());
    }
  }

  async function finish() {
    const activePausedMs = paused && pausedAt ? nowMs() - pausedAt : 0;
    const elapsed = Math.round((nowMs() - startTime - pausedMs - activePausedMs) / 1000);
    const answers = questionRows.map((question) => ({
      domain: 'cfa',
      topic: question.topic,
      questionId: question.id,
      learningObjective: question.learningObjective,
      objectiveTitle: objectiveMap.get(question.learningObjective)?.title || question.learningObjective,
      correct: selected[question.id] === question.correct,
      confidence: selected[question.id] === question.correct ? 'medium' : 'low',
      errorCategory: selected[question.id] === question.correct ? 'none' : question.errorCategories?.[0] || 'concept',
      difficulty: question.difficulty,
      selected: selected[question.id],
      correctIndex: question.correct,
      formula: question.formula,
      path: `/cfa/${level}/mock`,
      level,
      itemType: question.itemType || (level === 'level2' ? 'vignette' : 'mock-section'),
    }));
    const topicBreakdown = [...new Set(questionRows.map((question) => question.topic))].map((topic) => {
      const topicQuestions = questionRows.filter((question) => question.topic === topic);
      const topicScore = topicQuestions.filter((question) => selected[question.id] === question.correct).length;
      return { topic, score: topicScore, total: topicQuestions.length, pct: Math.round((topicScore / Math.max(1, topicQuestions.length)) * 100) };
    });
    const attempt = {
      domain: 'cfa',
      level,
      title: mock.title,
      mode: 'mock-section',
      score,
      total: questionRows.length,
      elapsedSeconds: elapsed,
      flaggedQuestionIds: [...flags],
      topicBreakdown,
      answers,
    };
    if (questionRows.length) await recordMockAttempt(attempt);
    for (const constructed of constructedItems) {
      const scores = rubricScores[constructed.id] || {};
      const earnedPoints = constructed.rubric.criteria.reduce((sum, criterion) => sum + Number(scores[criterion.id] || 0), 0);
      await recordConstructedResponseAttempt({
        domain: 'cfa',
        level,
        topic: constructed.topic,
        itemId: constructed.id,
        title: constructed.title,
        earnedPoints,
        maxPoints: constructed.rubric.maxPoints,
        rubricScores: scores,
        response: constructedResponses[constructed.id] || '',
        elapsedSeconds: Math.max(30, Math.round(elapsed / Math.max(1, constructedItems.length))),
        learningObjectives: constructed.learningObjectives,
        path: `/cfa/${level}/mock`,
      });
    }
    await clearMockSectionState(mockStateId);
    const constructedPoints = constructedItems.reduce((sum, constructed) => {
      const scores = rubricScores[constructed.id] || {};
      return sum + constructed.rubric.criteria.reduce((scoreSum, criterion) => scoreSum + Number(scores[criterion.id] || 0), 0);
    }, 0);
    const constructedMax = constructedItems.reduce((sum, constructed) => sum + constructed.rubric.maxPoints, 0);
    setReport({ ...attempt, constructedPoints, constructedMax, pct: Math.round((score / Math.max(1, questionRows.length)) * 100) });
    setElapsedSeconds(elapsed);
    setFinished(true);
  }

  function handleFinishRequest() {
    if (unansweredItems.length) {
      setReviewMode(true);
      return;
    }
    finish();
  }

  if (loading) {
    return (
      <div className="page-container" aria-busy="true">
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-card" />
      </div>
    );
  }

  if (!items.length || !levelContent || !mock) {
    return (
      <div className="page-container">
        <EmptyPanel title="This mock has no available items yet." tone="exam" />
      </div>
    );
  }

  if (finished) {
    const pct = Math.round((score / Math.max(1, questionRows.length)) * 100);
    return (
      <div className="page-container">
        <PageHeader badge="MOCK SECTION" title="Mock Section Report" subtitle="Your attempt has been recorded into readiness, review scheduling, and mastery snapshots." />
        <div className="grid-4 page-metrics">
          <MetricCard label="MCQ Score" value={`${pct}%`} detail={`${score}/${questionRows.length} correct`} icon={Trophy} />
          <MetricCard label="Constructed" value={report?.constructedMax ? `${report.constructedPoints}/${report.constructedMax}` : '-'} detail="Rubric points recorded" icon={PenLine} tone="warning" />
          <MetricCard label="Flagged" value={flags.size} detail="Items marked for review" icon={Flag} tone="warning" />
          <MetricCard label="Time" value={`${elapsedSeconds}s`} detail="Elapsed attempt time" icon={Timer} tone="success" />
        </div>
        <Panel
          tone="exam"
          title="Topic Breakdown"
          actions={
            <button className="btn btn-secondary" onClick={() => downloadMockSummary(report || { score, total: questionRows.length })}>
              <Download size={16} /> Export Summary
            </button>
          }
        >
          <div className="grid-2">
            {(report?.topicBreakdown || []).map((row) => (
              <Surface as={Link} key={row.topic} to={`/cfa/${level}/${row.topic.split(':').at(-1)}/quiz?mode=weak-areas`} tone="exam" interactive>
                <StatusBadge tone="accent">{topicTitleMap.get(row.topic) || row.topic}</StatusBadge>
                <h3>{row.pct}%</h3>
                <p className="muted-copy">{row.score}/{row.total} correct - open weak-area drill</p>
              </Surface>
            ))}
          </div>
        </Panel>
        <SourceRail
          title="Mock Source Context"
          subtitle="Official-first snippets mapped after the section is submitted."
          target={{
            kind: 'mock',
            domain: 'cfa',
            level,
            title: mock.title,
            objectiveIds: questionRows.map((question) => question.learningObjective),
            pathway: level === 'level3' ? activePathway : undefined,
            formulaNames: questionRows.map((question) => question.formula).filter(Boolean),
            keywords: [
              mock.title,
              ...(report?.topicBreakdown || []).map((row) => row.topic),
              ...constructedItems.map((constructed) => `${constructed.title} ${constructed.prompt}`),
            ],
            route: `/cfa/${level}/mock`,
          }}
          compact
        />
        {questionRows.filter((q) => selected[q.id] !== q.correct).length > 0 && (
          <Surface tone="exam" status="warning" style={{ marginBottom: 'var(--space-6)' }}>
            <h3 style={{ marginTop: 0 }}>Missed questions</h3>
            {questionRows
              .filter((q) => selected[q.id] !== q.correct)
              .map((question, index) => {
                const letters = ['A', 'B', 'C', 'D'];
                const pickedIndex = selected[question.id];
                const correctIndex = question.correct;
                const aiEntry = mockAiExplain[question.id];
                return (
                  <div
                    key={question.id}
                    style={{
                      borderTop: index ? '1px solid var(--border)' : 0,
                      paddingTop: index ? 'var(--space-4)' : 0,
                      marginTop: index ? 'var(--space-4)' : 0,
                    }}
                  >
                    <p style={{ fontWeight: 700, margin: '0 0 var(--space-2)' }}>{question.question}</p>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', margin: '0 0 var(--space-2)' }}>
                      Your answer: {pickedIndex !== undefined ? letters[pickedIndex] ?? pickedIndex : '—'} ·{' '}
                      Correct: {letters[correctIndex] ?? correctIndex}
                    </p>
                    {question.explanation && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', margin: '0 0 var(--space-3)', lineHeight: 1.6 }}>
                        {question.explanation}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: 'var(--space-2) var(--space-3)' }}
                        onClick={() => handleMockExplainWithAi(question, pickedIndex, correctIndex)}
                        disabled={aiEntry?.state === 'loading'}
                      >
                        {aiEntry?.state === 'loading' ? 'Thinking…' : '🤖 Explain with AI'}
                      </button>
                      {aiEntry?.state === 'loading' && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: 'var(--space-2) var(--space-3)' }}
                          onClick={() => mockAiAbortRef.current?.abort()}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {aiEntry?.state === 'done' && (
                      <p style={{ borderLeft: '3px solid var(--accent)', padding: 'var(--space-2) var(--space-3)', margin: 'var(--space-2) 0 0', background: 'var(--surface-2, rgba(120,180,255,0.06))', borderRadius: 'var(--radius-md, 8px)', whiteSpace: 'pre-line' }}>
                        {aiEntry.text}
                      </p>
                    )}
                    {aiEntry?.state === 'error' && (
                      <p style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0', fontSize: 'var(--fs-sm)' }}>
                        {aiEntry.error}
                      </p>
                    )}
                  </div>
                );
              })}
          </Surface>
        )}
        <InlineCluster className="mock-report-actions">
          <button className="btn btn-secondary" onClick={restart}>Restart</button>
          <Link to="/review" className="btn btn-primary">Open Review Inbox</Link>
        </InlineCluster>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        badge="MOCK SECTION"
        title={mock.title}
        subtitle="A level-aware mixed section with standalone items, vignettes, constructed responses, flags, review state, and local persistence."
        actions={
          <>
            <button className="btn btn-secondary" onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="btn btn-primary" onClick={handleFinishRequest} disabled={answered === 0}>Finish Section</button>
          </>
        }
      />

      <Surface density="compact" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
        <InlineCluster align="between">
          <div>
            <StatusBadge tone="accent">Mock source</StatusBadge>
            <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
              {generatedView
                ? 'Questions generated from your ingested curriculum by your local model.'
                : 'The hand-authored official-blueprint section. Generate a fresh set from your own curriculum below.'}
            </p>
            {genState === 'loading' && (
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                Generating{genProgress ? ` — ${genProgress.topicTitle} (${genProgress.done}/${genProgress.total})` : '…'}
              </p>
            )}
            {genState === 'error' && <p style={{ color: 'var(--danger)', margin: 'var(--space-1) 0 0' }}>{genError}</p>}
            {genState === 'cancelled' && (
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                Generation cancelled. Any previous generated mock is still available below.
              </p>
            )}
            {generatedMock && (() => {
              const byTopic = new Map();
              for (const question of generatedMock.questions || []) {
                const key = question.topicTitle || question.topic || '—';
                byTopic.set(key, (byTopic.get(key) || 0) + 1);
              }
              const entries = [...byTopic.entries()].sort((a, b) => b[1] - a[1]);
              if (entries.length === 0) return null;
              const stamp = new Date(generatedMock.generatedAt || Date.now()).toLocaleString();
              return (
                <div style={{ marginTop: 'var(--space-2)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <small className="muted-copy" style={{ width: '100%' }}>
                    Topic mix · {generatedMock.questions.length} question{generatedMock.questions.length === 1 ? '' : 's'} generated {stamp}
                  </small>
                  {entries.map(([title, count]) => (
                    <StatusBadge key={title} tone="accent">
                      {title} · {count}
                    </StatusBadge>
                  ))}
                </div>
              );
            })()}
          </div>
          <InlineCluster>
            {generatedMock && (
              <SegmentedControl
                label="Mock source"
                density="compact"
                options={[
                  { value: 'blueprint', label: 'Official' },
                  { value: 'generated', label: 'Generated' },
                ]}
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  setCurrent(0);
                  setSelected({});
                  setConstructedResponses({});
                  setRubricScores({});
                  setFlags(new Set());
                  setFinished(false);
                  setReviewMode(false);
                  setReport(null);
                }}
              />
            )}
            <button className="btn btn-secondary" onClick={handleGenerateMock} disabled={genState === 'loading'}>
              {genState === 'loading' ? 'Generating…' : generatedMock ? 'Regenerate from curriculum' : 'Generate from curriculum'}
            </button>
            {genState === 'loading' && (
              <button className="btn btn-secondary" onClick={handleCancelGenerateMock}>Cancel</button>
            )}
          </InlineCluster>
        </InlineCluster>
      </Surface>

      {level === 'level3' && (
        <Surface density="compact" status="exam" style={{ marginBottom: 'var(--space-6)' }}>
          <InlineCluster align="between">
            <div>
              <StatusBadge tone="exam">Level III pathway exam mode</StatusBadge>
              <p className="muted-copy">Mocks include common core plus one selected pathway.</p>
            </div>
            <SegmentedControl
              label="Level III pathway"
              density="compact"
              options={LEVEL3_PATHWAY_OPTIONS}
              value={activePathway}
              onChange={(nextPathway) => {
                setActivePathway(nextPathway);
                setCurrent(0);
                setSelected({});
                setConstructedResponses({});
                setRubricScores({});
                setFlags(new Set());
                setFinished(false);
                setReviewMode(false);
                setReport(null);
              }}
            />
          </InlineCluster>
        </Surface>
      )}

      <div className="grid-4 page-metrics">
        <MetricCard label="Answered" value={`${answered}/${questionRows.length + constructedItems.length}`} detail="Question and response items" icon={ListChecks} />
        <MetricCard label="Flagged" value={flags.size} detail="Marked for review" icon={Flag} tone="warning" />
        <MetricCard label="Item" value={current + 1} detail={topicTitleMap.get(itemTopic(item)) || itemTopic(item)} icon={Timer} tone="success" />
        <MetricCard label="Progress" value={`${Math.round(((current + 1) / items.length) * 100)}%`} detail="Section navigation" icon={Trophy} />
      </div>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <ProgressRail value={current + 1} max={items.length} label="Mock navigation" detail={`${current + 1}/${items.length}`} tone="exam" />
      </div>

      {paused && (
        <Surface className="mock-state-panel">
          <h2>Section Paused</h2>
          <p className="muted-copy">Timer is paused. Resume when you are ready to continue.</p>
          <button className="btn btn-primary" onClick={togglePause}>Resume Section</button>
        </Surface>
      )}

      {reviewMode && (
        <Surface status="warning" className="mock-state-panel">
          <h2 style={{ marginTop: 0 }}>Review Before Finish</h2>
          <p className="muted-copy">
            {unansweredItems.length} incomplete item{unansweredItems.length === 1 ? '' : 's'} remain. Jump to them now or finish with unanswered multiple-choice items marked incorrect.
          </p>
          <InlineCluster>
            {unansweredItems.slice(0, 10).map((mockItem) => (
              <button
                key={itemId(mockItem)}
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setCurrent(items.findIndex((candidate) => itemId(candidate) === itemId(mockItem)));
                  setReviewMode(false);
                }}
              >
                {items.findIndex((candidate) => itemId(candidate) === itemId(mockItem)) + 1}
              </button>
            ))}
            <button className="btn btn-primary btn-sm" onClick={finish}>Finish Anyway</button>
          </InlineCluster>
        </Surface>
      )}

      <div className="quiz-container" style={{ opacity: paused ? 0.45 : 1, pointerEvents: paused ? 'none' : 'auto' }}>
        <div className="flex-between" style={{ marginBottom: 'var(--space-5)' }}>
          <div>
            <span className="badge badge-purple">{item.type.replace('-', ' ')}</span>
            <h2 style={{ marginTop: 'var(--space-3)' }}>{itemTitle(item)}</h2>
          </div>
          <button className={`btn ${flags.has(itemId(item)) ? 'btn-primary' : 'btn-secondary'}`} onClick={toggleFlag}>
            <Flag size={16} /> {flags.has(itemId(item)) ? 'Flagged' : 'Flag'}
          </button>
        </div>

        {item.type === 'question' && (
          <MockQuestion
            question={item.question}
            selected={selected[item.question.id]}
            onSelect={(index) => setSelected((existing) => ({ ...existing, [item.question.id]: index }))}
          />
        )}
        {item.type === 'vignette' && (
          <>
            <CaseViewer title="Case Facts" exhibits={item.vignette.exhibits || []}>
              <p>{item.vignette.stem}</p>
            </CaseViewer>
            {item.vignette.questions.map((question) => (
              <MockQuestion
                key={question.id}
                question={question}
                selected={selected[question.id]}
                onSelect={(index) => setSelected((existing) => ({ ...existing, [question.id]: index }))}
              />
            ))}
          </>
        )}
        {item.type === 'constructed-response' && (
          <ConstructedItem
            item={item.constructed}
            response={constructedResponses[item.constructed.id]}
            scores={rubricScores[item.constructed.id]}
            onResponse={(response) => setConstructedResponses((existing) => ({ ...existing, [item.constructed.id]: response }))}
            onScore={(criterionId, value) =>
              setRubricScores((existing) => ({
                ...existing,
                [item.constructed.id]: {
                  ...(existing[item.constructed.id] || {}),
                  [criterionId]: value,
                },
              }))
            }
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }}>
          <button className="btn btn-secondary" onClick={() => setCurrent((value) => Math.max(0, value - 1))} disabled={current === 0}>Previous</button>
          <div className="mock-nav-grid">
            {items.map((mockItem, index) => (
              <button
                key={itemId(mockItem)}
                className={`btn btn-sm ${current === index ? 'btn-primary' : flags.has(itemId(mockItem)) ? 'btn-gold' : 'btn-secondary'}`}
                onClick={() => setCurrent(index)}
              >
                {index + 1}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={() => setCurrent((value) => Math.min(items.length - 1, value + 1))} disabled={current === items.length - 1}>Next</button>
        </div>
      </div>
    </div>
  );
}
