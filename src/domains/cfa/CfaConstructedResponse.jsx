import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, PenLine, Trophy } from 'lucide-react';
import { getCfaTopicKey, loadCfaTopicContent } from './cfaLoaders';
import { useLevel3Pathway } from './useLevel3Pathway';
import { CommandHint, EmptyPanel, MetricCard, PageHeader, ProgressRail, RubricPanel, SegmentedControl, StatusBadge, Surface } from '../../components/ui/Primitives';
import { recordConstructedResponseAttempt } from '../../lib/learning';
import { SourceRail } from '../../components/SourceContext';

function nowMs() {
  return Date.now();
}

export default function CfaConstructedResponse() {
  const { level, topic } = useParams();
  const [activePathway] = useLevel3Pathway();
  const requestKey = `${level}:${topic}:${level === 'level3' ? activePathway : 'all'}`;
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
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && response.trim() && !submitted) {
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

  if (!data || !item) {
    return (
      <div className="page-container">
        <EmptyPanel title="Constructed-response practice is available on Level III portfolio topics." tone="exam" />
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

      <SegmentedControl
        label="Constructed response command word filter"
        options={['all', ...commandWords].map((command) => ({ value: command, label: command }))}
        value={commandFilter}
        onChange={(command) => {
          setCommandFilter(command);
          resetForNextItem(0);
        }}
        density="compact"
      />

      <Surface tone="study" status="exam" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <h2 style={{ margin: 0 }}>Prompt</h2>
          <CommandHint keys={['Ctrl', 'Enter']} label="submit response" />
        </div>
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
      </Surface>

      <div style={{ marginBottom: 'var(--space-6)' }}>
        <RubricPanel
          title={item.rubric.title}
          criteria={item.rubric.criteria}
          scores={scores}
          maxPoints={item.rubric.maxPoints}
          onScore={(criterionId, value) => setScores((existing) => ({ ...existing, [criterionId]: value }))}
        />
        <div style={{ marginTop: 'var(--space-4)' }}>
          <ProgressRail value={earnedPoints} max={item.rubric.maxPoints} label="Rubric points" detail={`${earnedPoints}/${item.rubric.maxPoints}`} tone="exam" />
        </div>
      </div>

      {submitted && (
        <>
          <Surface tone="study" status="success" style={{ marginBottom: 'var(--space-6)' }}>
            <StatusBadge tone="success">Model answer revealed</StatusBadge>
            <h2>Model Answer</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{item.modelAnswer}</p>
          </Surface>
          <SourceRail
            title="Constructed Response Source Context"
            subtitle="Private snippets are shown only after submission and mapped to command words, rubric criteria, and objectives."
            target={{
              kind: 'constructed-response',
              domain: 'cfa',
              level,
              topicId: topic,
              pathway: level === 'level3' ? activePathway : undefined,
              title: item.title,
              objectiveIds: item.learningObjectives,
              keywords: [item.prompt, item.modelAnswer, item.commandWords.join(' '), item.rubric.criteria.map((criterion) => criterion.label).join(' ')],
              route: `/cfa/${level}/${topic}/constructed-response`,
            }}
            compact
          />
        </>
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
