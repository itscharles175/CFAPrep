import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, Flag, ListChecks, PenLine, Timer, Trophy } from 'lucide-react';
import { getCfaLevelContent, getCfaMockExam } from '../domains/cfa/cfaLevels';
import { PageHeader, MetricCard } from '../components/ui/Primitives';
import {
  clearMockSectionState,
  getMockSectionState,
  recordConstructedResponseAttempt,
  recordMockAttempt,
  saveMockSectionState,
} from '../lib/learning';

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

function buildMockItems(level) {
  const levelContent = getCfaLevelContent(level);
  const mock = getCfaMockExam(level);
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
    <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-5)' }}>
      <span className="badge badge-purple">{question.difficulty}</span>
      <h2 style={{ marginTop: 'var(--space-3)' }}>{question.question}</h2>
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
    </div>
  );
}

function ConstructedItem({ item, response, scores, onResponse, onScore }) {
  return (
    <div className="glass-card no-hover">
      <span className="badge badge-gold">Constructed Response</span>
      <h2>{item.title}</h2>
      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.prompt}</p>
      <textarea
        aria-label={`${item.title} response`}
        value={response || ''}
        onChange={(event) => onResponse(event.target.value)}
        placeholder="Write a concise bullet response..."
        style={{ width: '100%', minHeight: 180, resize: 'vertical', marginTop: 'var(--space-4)' }}
      />
      <div className="analytics-table" style={{ marginTop: 'var(--space-5)' }}>
        {item.rubric.criteria.map((criterion) => (
          <label key={criterion.id} className="analytics-row">
            <span>
              <strong>{criterion.label}</strong>
              <small style={{ display: 'block', color: 'var(--text-secondary)' }}>{criterion.description}</small>
            </span>
            <input
              type="number"
              min="0"
              max={criterion.points}
              value={scores?.[criterion.id] ?? 0}
              onChange={(event) => onScore(criterion.id, Number(event.target.value))}
              style={{ width: 80 }}
            />
            <span>/ {criterion.points}</span>
          </label>
        ))}
      </div>
      <details style={{ marginTop: 'var(--space-5)' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Model answer</summary>
        <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-3)' }}>{item.modelAnswer}</p>
      </details>
    </div>
  );
}

export default function MockExam() {
  const params = useParams();
  const level = params.level || 'level1';
  const levelContent = useMemo(() => getCfaLevelContent(level), [level]);
  const mock = useMemo(() => getCfaMockExam(level), [level]);
  const items = useMemo(() => buildMockItems(level), [level]);
  const objectiveMap = useMemo(
    () => new Map(levelContent.topics.flatMap((topic) => topic.learningObjectives).map((objective) => [objective.id, objective])),
    [levelContent],
  );
  const topicTitleMap = useMemo(() => new Map(levelContent.topics.map((topic) => [topic.topic, topic.title])), [levelContent]);
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
    let active = true;
    getMockSectionState(`cfa-${level}-mixed-mock`).then((state) => {
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
  }, [level, items]);

  useEffect(() => {
    if (!hydrated || finished || !items.length) return;
    saveMockSectionState({
      id: `cfa-${level}-mixed-mock`,
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
  }, [constructedResponses, current, flags, finished, hydrated, items, level, mock.title, paused, pausedAt, pausedMs, rubricScores, selected, startTime]);

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
    clearMockSectionState(`cfa-${level}-mixed-mock`);
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
    await clearMockSectionState(`cfa-${level}-mixed-mock`);
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

  if (!items.length) {
    return (
      <div className="page-container">
        <div className="glass-card no-hover">This mock has no available items yet.</div>
      </div>
    );
  }

  if (finished) {
    const pct = Math.round((score / Math.max(1, questionRows.length)) * 100);
    return (
      <div className="page-container">
        <PageHeader badge="MOCK SECTION" title="Mock Section Report" subtitle="Your attempt has been recorded into readiness, review scheduling, and mastery snapshots." />
        <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
          <MetricCard label="MCQ Score" value={`${pct}%`} detail={`${score}/${questionRows.length} correct`} icon={Trophy} />
          <MetricCard label="Constructed" value={report?.constructedMax ? `${report.constructedPoints}/${report.constructedMax}` : '-'} detail="Rubric points recorded" icon={PenLine} tone="warning" />
          <MetricCard label="Flagged" value={flags.size} detail="Items marked for review" icon={Flag} tone="warning" />
          <MetricCard label="Time" value={`${elapsedSeconds}s`} detail="Elapsed attempt time" icon={Timer} tone="success" />
        </div>
        <div className="glass-card no-hover">
          <div className="flex-between" style={{ marginBottom: 'var(--space-4)' }}>
            <h3 style={{ marginTop: 0 }}>Topic Breakdown</h3>
            <button className="btn btn-secondary" onClick={() => downloadMockSummary(report || { score, total: questionRows.length })}>
              <Download size={16} /> Export Summary
            </button>
          </div>
          <div className="grid-2">
            {(report?.topicBreakdown || []).map((row) => (
              <Link key={row.topic} to={`/cfa/${level}/${row.topic.split(':').at(-1)}/quiz?mode=weak-areas`} className="glass-card" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span className="badge badge-blue">{topicTitleMap.get(row.topic) || row.topic}</span>
                <h3>{row.pct}%</h3>
                <p style={{ color: 'var(--text-secondary)' }}>{row.score}/{row.total} correct - open weak-area drill</p>
              </Link>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }}>
          <button className="btn btn-secondary" onClick={restart}>Restart</button>
          <Link to="/review" className="btn btn-primary">Open Review Inbox</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        badge={levelContent.runtimeMode === 'validated-beta' ? 'MOCK SECTION · AUTHORED BETA' : 'MOCK SECTION'}
        title={mock.title}
        subtitle={
          levelContent.runtimeMode === 'validated-beta'
            ? 'Validated beta authored Level I items are used locally; public release still waits for editorial exam-ready provenance.'
            : 'A level-aware mixed section with standalone items, vignettes, constructed responses, flags, review state, and local persistence.'
        }
        actions={
          <>
            <button className="btn btn-secondary" onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="btn btn-primary" onClick={handleFinishRequest} disabled={answered === 0}>Finish Section</button>
          </>
        }
      />

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Answered" value={`${answered}/${questionRows.length + constructedItems.length}`} detail="Question and response items" icon={ListChecks} />
        <MetricCard label="Flagged" value={flags.size} detail="Marked for review" icon={Flag} tone="warning" />
        <MetricCard label="Item" value={current + 1} detail={topicTitleMap.get(itemTopic(item)) || itemTopic(item)} icon={Timer} tone="success" />
        <MetricCard label="Progress" value={`${Math.round(((current + 1) / items.length) * 100)}%`} detail="Section navigation" icon={Trophy} />
      </div>

      {paused && (
        <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)', textAlign: 'center' }}>
          <h2>Section Paused</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Timer is paused. Resume when you are ready to continue.</p>
          <button className="btn btn-primary" onClick={togglePause}>Resume Section</button>
        </div>
      )}

      {reviewMode && (
        <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)', borderColor: 'rgba(245,158,11,0.35)' }}>
          <h2 style={{ marginTop: 0 }}>Review Before Finish</h2>
          <p style={{ color: 'var(--text-secondary)' }}>
            {unansweredItems.length} incomplete item{unansweredItems.length === 1 ? '' : 's'} remain. Jump to them now or finish with unanswered multiple-choice items marked incorrect.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
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
          </div>
        </div>
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
            <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-5)' }}>
              <h3 style={{ marginTop: 0 }}>Case Facts</h3>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.vignette.stem}</p>
              {item.vignette.exhibits?.length > 0 && (
                <div className="coverage-grid">
                  {item.vignette.exhibits.map((exhibit) => (
                    <div key={exhibit.id}>
                      <strong>{exhibit.title}</strong>
                      <small>{exhibit.content}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
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
