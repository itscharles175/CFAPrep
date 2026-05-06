import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, PenLine, Trophy } from 'lucide-react';
import { getCfaTopicKey, loadCfaTopicContent } from './cfaLoaders';
import { PageHeader, MetricCard } from '../../components/ui/Primitives';
import { recordConstructedResponseAttempt } from '../../lib/learning';

function nowMs() {
  return Date.now();
}

export default function CfaConstructedResponse() {
  const { level, topic } = useParams();
  const requestKey = `${level}:${topic}`;
  const [contentState, setContentState] = useState({ key: null, data: null });
  const data = contentState.key === requestKey ? contentState.data : null;
  const loading = contentState.key !== requestKey;
  const topicKey = useMemo(() => getCfaTopicKey(level, topic), [level, topic]);
  const [itemIndex, setItemIndex] = useState(0);
  const [commandFilter, setCommandFilter] = useState('all');
  const allItems = useMemo(() => data?.constructedResponses || [], [data]);
  const commandWords = useMemo(() => [...new Set(allItems.flatMap((responseItem) => responseItem.commandWords))], [allItems]);
  const visibleItems = useMemo(
    () => (commandFilter === 'all' ? allItems : allItems.filter((responseItem) => responseItem.commandWords.includes(commandFilter))),
    [allItems, commandFilter],
  );
  const safeIndex = Math.min(itemIndex, Math.max(0, visibleItems.length - 1));
  const item = visibleItems[safeIndex];
  const [response, setResponse] = useState('');
  const [scores, setScores] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [startTime] = useState(nowMs);

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

  if (!data || !item) {
    return (
      <div className="page-container">
        <div className="glass-card no-hover">Constructed-response practice is available on Level III portfolio topics.</div>
      </div>
    );
  }

  const earnedPoints = item.rubric.criteria.reduce((sum, criterion) => sum + Number(scores[criterion.id] || 0), 0);
  const pct = Math.round((earnedPoints / item.rubric.maxPoints) * 100);

  function resetForNextItem(nextIndex) {
    setItemIndex(nextIndex);
    setResponse('');
    setScores({});
    setSubmitted(false);
  }

  async function submit() {
    await recordConstructedResponseAttempt({
      domain: 'cfa',
      level,
      topic: topicKey,
      itemId: item.id,
      title: item.title,
      earnedPoints,
      maxPoints: item.rubric.maxPoints,
      rubricScores: scores,
      response,
      elapsedSeconds: Math.round((nowMs() - startTime) / 1000),
      learningObjectives: item.learningObjectives,
      path: `/cfa/${level}/${topic}/constructed-response`,
    });
    setSubmitted(true);
  }

  return (
    <div className="page-container">
      <Link to={`/cfa/${level}/${topic}`} className="back-link">
        <ArrowLeft size={16} /> Back to {data.title}
      </Link>
      <PageHeader
        badge="LEVEL III RESPONSE"
        title={item.title}
        subtitle="Practice concise command-word responses across the full local topic set, then self-score against a local rubric."
      />

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Command Words" value={item.commandWords.join(', ')} detail="Answer exactly what is asked" icon={PenLine} />
        <MetricCard label="Rubric" value={`${item.rubric.maxPoints} pts`} detail={item.rubric.title} icon={ClipboardCheck} tone="success" />
        <MetricCard label="Score" value={submitted ? `${pct}%` : '-'} detail={submitted ? `${earnedPoints}/${item.rubric.maxPoints} pts` : 'Self-score to submit'} icon={Trophy} tone="warning" />
        <MetricCard label="Set" value={`${safeIndex + 1}/${visibleItems.length}`} detail={`${allItems.length} total prompts`} icon={ClipboardCheck} tone="accent" />
      </div>

      <div className="segmented-row" role="tablist" aria-label="Constructed response command word filter">
        {['all', ...commandWords].map((command) => (
          <button
            key={command}
            type="button"
            role="tab"
            aria-selected={commandFilter === command}
            className={`btn ${commandFilter === command ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setCommandFilter(command);
              resetForNextItem(0);
            }}
          >
            {command}
          </button>
        ))}
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h2 style={{ marginTop: 0 }}>Prompt</h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.prompt}</p>
        <textarea
          aria-label="Constructed response answer"
          value={response}
          onChange={(event) => setResponse(event.target.value)}
          placeholder="Write a concise bullet response..."
          style={{
            width: '100%',
            minHeight: 180,
            resize: 'vertical',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--text-primary)',
            padding: 'var(--space-3)',
            lineHeight: 1.6,
          }}
        />
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h2 style={{ marginTop: 0 }}>Rubric</h2>
        <div className="analytics-table">
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
                value={scores[criterion.id] ?? 0}
                onChange={(event) => setScores((existing) => ({ ...existing, [criterion.id]: Number(event.target.value) }))}
                style={{ width: 80 }}
              />
              <span>/ {criterion.points}</span>
            </label>
          ))}
        </div>
      </div>

      {submitted && (
        <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
          <h2 style={{ marginTop: 0 }}>Model Answer</h2>
          <p style={{ color: 'var(--text-secondary)' }}>{item.modelAnswer}</p>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {visibleItems.map((responseItem, index) => (
            <button
              key={responseItem.id}
              type="button"
              className={`btn btn-sm ${safeIndex === index ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => resetForNextItem(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={submit} disabled={!response.trim() || submitted}>
          Submit Response
        </button>
      </div>
    </div>
  );
}
