import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { loadCfaTopicContent } from './cfaLoaders';
import { level3PathwayForTopic } from './cfaLevel3Pathways';
import { useLevel3Pathway } from './useLevel3Pathway';
import { ArrowLeft, Target, BookOpen, Lightbulb, ChevronRight, Bookmark, StickyNote, Layers, PenLine } from 'lucide-react';
import FormulaBlock from '../../components/FormulaBlock';
import { useModuleProgress } from '../../hooks/useProgress';
import { getBookmark, getNote, saveNote, toggleBookmark } from '../../lib/learning';
import { EmptyPanel, PageHeader, ProgressRail, SegmentedControl, StatusBadge, Surface } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';
import { getCfaSourceReadingForTopic } from '../../lib/cfaSourceVault';
import { bootstrapSourceVault } from '../../lib/bootstrapSourceVault';
import { generateFlashcardsFromCurriculum, generateQuestionsFromCurriculum, getCachedGeneratedFlashcards, getCachedGeneratedQuestions, getLlmSettings, saveCachedGeneratedFlashcards, saveCachedGeneratedQuestions, summarizeTopicFromCurriculum } from '../../lib/localLlm';
import {
  askGrounded,
  chatWithSource,
  ensureSourceInsights,
  ensureTopicNotebook,
  fetchSourceTitleMap,
  getCachedGroundedAnswer,
  getCachedGroundedAnswerHistory,
  getOpenNotebookSettings,
  listSourceInsights,
  saveCachedGroundedAnswer,
} from '../../lib/openNotebook';
import { parseCitations } from '../../lib/citations';
import { hasSpeechRecognition, hasSpeechSynthesis, recognizeOnce, recognizeOnceOffline, recordAudioForOfflineStt, sanitizeForSpeech, speak, stopSpeaking } from '../../lib/voice';
import PodcastPanel from '../../components/PodcastPanel/PodcastPanel';

// Interactive deck for AI-generated flashcards: front visible by default,
// click reveals the back; small Show all / Hide all controls.
function FlashcardDeck({ cards }) {
  const [revealed, setRevealed] = useState(new Set());
  const allShown = revealed.size === cards.length;
  function toggle(id) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div>
      <div className="qv-mb-2" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setRevealed(allShown ? new Set() : new Set(cards.map((c) => c.id)))}
        >
          {allShown ? 'Hide all' : 'Show all'}
        </button>
      </div>
      {cards.map((card) => {
        const isOpen = revealed.has(card.id);
        return (
          <div
            key={card.id}
            style={{
              borderTop: '1px solid var(--border)',
              paddingTop: 'var(--space-3)',
              marginTop: 'var(--space-3)',
              cursor: 'pointer',
            }}
            onClick={() => toggle(card.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle(card.id);
              }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
          >
            <div className="qv-row-3-start" style={{ justifyContent: 'space-between' }}>
              <strong style={{ flex: 1 }}>{card.front}</strong>
              {card.locator && (
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 'var(--fs-xs)',
                    fontFamily: 'var(--font-mono, monospace)',
                    background: 'var(--accent-soft, rgba(120,180,255,0.15))',
                    color: 'var(--accent, currentColor)',
                    border: '1px solid var(--accent, transparent)',
                    borderRadius: 'var(--radius-sm, 4px)',
                    padding: '1px 6px',
                  }}
                >
                  {card.locator}
                </span>
              )}
            </div>
            {isOpen ? (
              <p className="qv-text-secondary" style={{ margin: 'var(--space-2) 0 0' }}>{card.back}</p>
            ) : (
              <small className="muted-copy">Click to reveal</small>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CfaModule() {
  const { level, topic } = useParams();
  const location = useLocation();
  const [activePathway] = useLevel3Pathway();
  const pathwayScoped = level === 'level3' && level3PathwayForTopic(topic) !== null;
  const requestKey = `${level}:${topic}:${level === 'level3' ? activePathway : 'all'}`;
  const [contentState, setContentState] = useState({ key: null, data: null });
  const data = contentState.key === requestKey ? contentState.data : null;
  const loading = contentState.key !== requestKey;
  const moduleId = data ? `${level}:${topic}` : null;
  const { completed, toggleComplete } = useModuleProgress({
    domain: 'cfa',
    moduleId,
    title: data?.title || topic,
    path: location.pathname,
  });
  const [noteBody, setNoteBody] = useState('');
  const [noteSavedAt, setNoteSavedAt] = useState(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [reading, setReading] = useState({ document: null, chunks: [] });
  const [readingView, setReadingView] = useState('lessons');
  const [chunkLimit, setChunkLimit] = useState(6);
  const [aiQuestions, setAiQuestions] = useState([]);
  const [aiState, setAiState] = useState('idle');
  const [aiError, setAiError] = useState('');
  const [aiFlashcards, setAiFlashcards] = useState([]);
  const [aiFlashState, setAiFlashState] = useState('idle');
  const [aiFlashError, setAiFlashError] = useState('');
  const aiFlashAbortRef = useRef(null);
  const [summaryState, setSummaryState] = useState({ state: 'idle', text: '', error: '' });
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askState, setAskState] = useState('idle');
  const [askError, setAskError] = useState('');
  const [sourceTitleMap, setSourceTitleMap] = useState(null);
  const askAbortRef = useRef(null);
  const [askHistory, setAskHistory] = useState([]);
  const [voiceState, setVoiceState] = useState('idle'); // 'idle' | 'listening' | 'recording' | 'transcribing' | 'speaking'
  const [voiceMode, setVoiceMode] = useState('browser'); // 'browser' | 'offline'
  const [voiceProgress, setVoiceProgress] = useState(null); // progress_callback payload from Whisper download
  const voiceAbortRef = useRef(null);
  const hasMediaDevices = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    let cancelled = false;
    loadCfaTopicContent(level, topic, level === 'level3' ? { pathway: activePathway } : {})
      .then((topicContent) => {
        if (!cancelled) setContentState({ key: requestKey, data: topicContent });
      })
      .catch(() => {
        if (!cancelled) setContentState({ key: requestKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activePathway, level, requestKey, topic]);

  useEffect(() => {
    let cancelled = false;

    async function loadVaultState() {
      if (!data || !topic) return;
      const vaultModuleId = `${level}:${topic}`;
      const [note, bookmark] = await Promise.all([
        getNote({ type: 'lesson', domain: 'cfa', moduleId: vaultModuleId }),
        getBookmark({ type: 'lesson', domain: 'cfa', moduleId: vaultModuleId }),
      ]);
      if (!cancelled) {
        setNoteBody(note?.body || '');
        setNoteSavedAt(note?.updatedAt || null);
        setBookmarked(Boolean(bookmark));
      }
    }

    loadVaultState();
    return () => {
      cancelled = true;
    };
  }, [data, level, topic]);

  // Phase 2: load the real ingested curriculum for this topic (if any) so the
  // reader can toggle between native curriculum text and authored lessons.
  useEffect(() => {
    let cancelled = false;
    if (!data || !topic) return undefined;
    // Wait for the first-run curriculum import to finish (memoized, resolves
    // immediately once populated) so the reader doesn't race the bootstrap.
    Promise.resolve(bootstrapSourceVault())
      .then(() => getCfaSourceReadingForTopic(level, topic))
      .then((result) => {
        if (cancelled) return;
        setReading(result);
        setChunkLimit(6);
        setReadingView(result.chunks.length ? 'curriculum' : 'lessons');
      })
      .catch(() => {
        if (!cancelled) setReading({ document: null, chunks: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [data, level, topic]);

  // Phase 4: load any previously cached AI-generated practice for this topic.
  useEffect(() => {
    let cancelled = false;
    if (!topic) return undefined;
    getCachedGeneratedQuestions(level, topic).then((cached) => {
      if (cancelled) return;
      setAiQuestions(cached?.questions || []);
      setAiState(cached?.questions?.length ? 'done' : 'idle');
      setAiError('');
    });
    return () => {
      cancelled = true;
    };
  }, [level, topic]);

  // Phase 4b: rehydrate cached AI-generated flashcards for this topic.
  useEffect(() => {
    let cancelled = false;
    if (!topic) return undefined;
    getCachedGeneratedFlashcards(level, topic).then((cached) => {
      if (cancelled) return;
      setAiFlashcards(cached?.flashcards || []);
      setAiFlashState(cached?.flashcards?.length ? 'done' : 'idle');
      setAiFlashError('');
    });
    return () => {
      cancelled = true;
    };
  }, [level, topic]);

  // Rehydrate the last grounded Q&A for this topic so it survives navigation.
  useEffect(() => {
    let cancelled = false;
    if (!topic) return undefined;
    Promise.all([
      getCachedGroundedAnswer(level, topic),
      getCachedGroundedAnswerHistory(level, topic),
    ]).then(([cached, history]) => {
      if (cancelled) return;
      setAskQuestion(cached?.question || '');
      setAskAnswer(cached?.answer || '');
      setAskState(cached?.answer ? 'done' : 'idle');
      setAskError('');
      setAskHistory(history || []);
    });
    return () => {
      cancelled = true;
    };
  }, [level, topic]);

  // Preload the open-notebook source-title map (when the backend is enabled)
  // so rehydrated cited answers render named citations on first paint.
  useEffect(() => {
    let cancelled = false;
    getOpenNotebookSettings().then((settings) => {
      if (cancelled || !settings.enabled) return;
      fetchSourceTitleMap(settings.baseUrl)
        .then((map) => {
          if (!cancelled) setSourceTitleMap(map);
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSummarize() {
    setSummaryState({ state: 'loading', text: '', error: '' });
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setSummaryState({ state: 'error', text: '', error: 'Enable a local model in System Health → Local AI first.' });
        return;
      }
      if (!reading.chunks?.length) {
        setSummaryState({ state: 'error', text: '', error: 'No ingested curriculum for this topic — import a .qvsource bundle or ingest a folder in System Health.' });
        return;
      }
      const text = await summarizeTopicFromCurriculum({
        settings,
        topicTitle: data.title,
        chunks: reading.chunks.slice(0, 14),
      });
      setSummaryState({ state: 'done', text, error: '' });
    } catch (error) {
      setSummaryState({
        state: 'error',
        text: '',
        error: error instanceof Error ? error.message : 'Summary failed.',
      });
    }
  }

  async function handleGenerate() {
    setAiState('loading');
    setAiError('');
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setAiState('error');
        setAiError('Enable a local model in System Health → Local AI first.');
        return;
      }
      const questions = await generateQuestionsFromCurriculum({
        settings,
        topicTitle: data.title,
        chunks: reading.chunks.slice(0, 14),
        count: 4,
      });
      setAiQuestions(questions);
      setAiState('done');
      await saveCachedGeneratedQuestions(level, topic, questions);
    } catch (error) {
      setAiState('error');
      setAiError(error instanceof Error ? error.message : 'Generation failed.');
    }
  }

  async function handleGenerateFlashcards() {
    const controller = new AbortController();
    aiFlashAbortRef.current = controller;
    setAiFlashState('loading');
    setAiFlashError('');
    try {
      const settings = await getLlmSettings();
      if (!settings.enabled) {
        setAiFlashState('error');
        setAiFlashError('Enable a local model in System Health → Local AI first.');
        return;
      }
      const cards = await generateFlashcardsFromCurriculum({
        settings,
        topicTitle: data.title,
        chunks: reading.chunks.slice(0, 14),
        count: 6,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        setAiFlashState('idle');
        return;
      }
      setAiFlashcards(cards);
      setAiFlashState('done');
      await saveCachedGeneratedFlashcards(level, topic, cards);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setAiFlashState('idle');
      } else {
        setAiFlashState('error');
        setAiFlashError(error instanceof Error ? error.message : 'Flashcard generation failed.');
      }
    } finally {
      aiFlashAbortRef.current = null;
    }
  }

  function handleCancelFlashcards() {
    aiFlashAbortRef.current?.abort();
  }

  // Grounded RAG: ask the embedded open-notebook backend a question answered
  // strictly from this topic's ingested curriculum (cited synthesis).
  // Accepts an optional questionOverride so the mic handler can pass a
  // freshly-captured transcript without waiting for React state to settle.
  async function handleAskCurriculum(questionOverride) {
    const question = (typeof questionOverride === 'string' ? questionOverride : askQuestion).trim();
    if (!question) return;
    setAskState('loading');
    setAskError('');
    setAskAnswer('');
    const controller = new AbortController();
    askAbortRef.current = controller;
    try {
      const settings = await getOpenNotebookSettings();
      if (!settings.enabled) {
        setAskState('error');
        setAskError('Enable the embedded notebook in System Health → Embedded Notebook first.');
        return;
      }
      const { sourceId } = await ensureTopicNotebook({
        baseUrl: settings.baseUrl,
        topicKey: `${level}:${topic}`,
        topicTitle: data.title,
        // Seed the whole topic — open-notebook re-chunks + embeds + retrieves
        // by relevance, so partial seeds force "not enough info" responses on
        // questions about deeper sections (front-matter only otherwise).
        seedChunks: reading.chunks,
        signal: controller.signal,
      });
      // Progressive enhancement: per-source chat is truly scoped to this
      // topic's source but only works once insights have been generated for
      // it. On the first ask we fall back to the (content-rich, global)
      // ask/simple endpoint and fire insight generation in the background;
      // on later asks for the same topic the insights are present and we
      // upgrade to the scoped chat.
      let answer;
      let usedScopedChat = false;
      if (sourceId) {
        const existing = await listSourceInsights(settings.baseUrl, sourceId).catch(() => []);
        if (existing.length > 0) {
          const scoped = await chatWithSource({ baseUrl: settings.baseUrl, sourceId, message: question, signal: controller.signal });
          answer = scoped.answer || 'No answer was returned.';
          usedScopedChat = true;
        } else {
          // Kick off insight generation for next time; don't await — the user
          // shouldn't pay the indexing cost on this ask.
          void ensureSourceInsights({ baseUrl: settings.baseUrl, sourceId, maxWaitMs: 300_000 }).catch(() => undefined);
        }
      }
      if (!usedScopedChat) {
        const result = await askGrounded({ baseUrl: settings.baseUrl, question, signal: controller.signal });
        answer = result.answer || 'No answer was returned.';
      }
      if (controller.signal.aborted) {
        setAskState('cancelled');
        return;
      }
      setAskAnswer(answer);
      setAskState('done');
      await saveCachedGroundedAnswer(level, topic, { question, answer });
      const refreshed = await getCachedGroundedAnswerHistory(level, topic);
      setAskHistory(refreshed);
      // Refresh the source-title map so the citation legend can name the
      // sources cited inline. Fire-and-forget; legend just falls back to ids.
      fetchSourceTitleMap(settings.baseUrl)
        .then((map) => setSourceTitleMap(map))
        .catch(() => undefined);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        setAskState('cancelled');
      } else {
        setAskState('error');
        setAskError(error instanceof Error ? error.message : 'Grounded answer failed.');
      }
    } finally {
      askAbortRef.current = null;
    }
  }

  function handleCancelAsk() {
    askAbortRef.current?.abort();
  }

  async function handleMicClick() {
    if (voiceState === 'listening') {
      voiceAbortRef.current?.abort();
      return;
    }
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setVoiceState('listening');
    try {
      const { transcript } = await recognizeOnce({ lang: 'en-US', signal: controller.signal });
      setAskQuestion(transcript);
      setVoiceState('idle');
      // Auto-trigger ask with the transcript directly (state hasn't settled yet).
      if (transcript.trim()) {
        handleAskCurriculum(transcript);
      }
    } catch (_error) {
      setVoiceState('idle');
    }
  }

  async function handleOfflineMicClick() {
    if (voiceState === 'recording' || voiceState === 'transcribing') {
      voiceAbortRef.current?.abort();
      setVoiceState('idle');
      return;
    }
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setVoiceProgress(null);
    setVoiceState('recording');
    try {
      const audio = await recordAudioForOfflineStt({ durationMs: 8000, signal: controller.signal });
      if (controller.signal.aborted) { setVoiceState('idle'); return; }
      setVoiceState('transcribing');
      const { transcript } = await recognizeOnceOffline({
        audio,
        lang: 'en',
        signal: controller.signal,
        onProgress: (p) => setVoiceProgress(p),
      });
      setVoiceProgress(null);
      if (transcript) {
        setAskQuestion(transcript);
        handleAskCurriculum(transcript);
      }
    } catch (_error) {
      setVoiceProgress(null);
    } finally {
      setVoiceState('idle');
    }
  }

  async function handleSpeakClick() {
    if (!askAnswer) return;
    if (voiceState === 'speaking') {
      stopSpeaking();
      setVoiceState('idle');
      return;
    }
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setVoiceState('speaking');
    try {
      await speak(sanitizeForSpeech(askAnswer), { lang: 'en-US', rate: 1.05, signal: controller.signal });
    } catch (_error) {
      // AbortError or synthesis error — either way just reset
    } finally {
      setVoiceState('idle');
    }
  }

  async function handleSaveNote() {
    if (!data || !topic) return;
    const note = await saveNote({
      type: 'lesson',
      domain: 'cfa',
      moduleId: `${level}:${topic}`,
      title: `${data.title} lesson note`,
      body: noteBody,
      path: location.pathname,
    });
    setNoteSavedAt(note.updatedAt);
  }

  /** Append the current grounded Q&A to this lesson's local note. */
  async function handleSaveAskToNotes() {
    if (!data || !topic || !askAnswer) return;
    const stamp = new Date().toLocaleString();
    const block = `## ${askQuestion} _(${stamp})_\n${askAnswer}`;
    const nextBody = noteBody?.trim() ? `${noteBody.trim()}\n\n${block}\n` : `${block}\n`;
    setNoteBody(nextBody);
    const note = await saveNote({
      type: 'lesson',
      domain: 'cfa',
      moduleId: `${level}:${topic}`,
      title: `${data.title} lesson note`,
      body: nextBody,
      path: location.pathname,
    });
    setNoteSavedAt(note.updatedAt);
  }

  async function handleToggleBookmark() {
    if (!data || !topic) return;
    const bookmark = await toggleBookmark({
      type: 'lesson',
      domain: 'cfa',
      moduleId: `${level}:${topic}`,
      title: data.title,
      path: location.pathname,
    });
    setBookmarked(Boolean(bookmark));
  }

  if (loading) {
    return (
      <div className="page-container" aria-busy="true">
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page-container">
        <EmptyPanel
          title="Module Coming Soon"
          description="This topic is currently being developed. Check back soon!"
          tone="exam"
          action={<Link to="/cfa" className="btn btn-primary">Back to CFA Dashboard</Link>}
        />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Link to="/cfa" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-4)' }}>
          <ArrowLeft size={16} /> Back to CFA Dashboard
        </Link>
        <PageHeader
          tone="exam"
          badge={`${level?.replace('level', 'Level ')} · ${data.weight}`}
          title={data.title}
          subtitle={`${data.learningObjectives.length} objectives · ${data.questions.length} questions · ${data.vignettes.length} vignettes · ${data.flashcards.length} cards`}
          actions={
            <>
            <button className={`btn ${completed ? 'btn-success' : 'btn-secondary'} btn-lg`} onClick={toggleComplete}>
              {completed ? 'Completed' : 'Mark Complete'}
            </button>
            <Link to={`/cfa/${level}/${topic}/quiz`} className="btn btn-primary btn-lg">
              <Target size={18} /> Take Quiz <ChevronRight size={16} />
            </Link>
            <Link to={`/cfa/${level}/${topic}/vignette`} className="btn btn-secondary btn-lg">
              <Layers size={18} /> Vignette
            </Link>
            {data.constructedResponses.length > 0 && (
              <Link to={`/cfa/${level}/${topic}/constructed-response`} className="btn btn-secondary btn-lg">
                <PenLine size={18} /> Response
              </Link>
            )}
            </>
          }
        />
      </div>

      <div className="study-shell">
        {/* Main Content */}
        <div className="module-content">
          <Surface tone="study" status="exam" className="objective-rail" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="flex-between qv-mb-2" style={{ gap: 'var(--space-3)' }}>
              <h2 className="qv-m-0">Objective Rail</h2>
              <StatusBadge tone="exam">{data.learningObjectives.length} mapped</StatusBadge>
            </div>
            <ProgressRail value={completed ? data.sections.length : Math.max(1, Math.floor(data.sections.length / 3))} max={data.sections.length} label="Reading progress" tone="exam" />
            <div className="objective-rail" style={{ marginTop: 'var(--space-4)' }}>
              {data.learningObjectives.slice(0, 8).map((objective, index) => (
                <div key={objective.id || index} className="objective-row">
                  <strong>{objective.title || objective.id || `Objective ${index + 1}`}</strong>
                  <small>{objective.commandWord ? `${objective.commandWord} · ` : ''}{objective.id}</small>
                </div>
              ))}
            </div>
          </Surface>

          {reading.chunks.length > 0 && (
            <Surface tone="study" density="compact" style={{ marginBottom: 'var(--space-4)' }}>
              <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
                <div>
                  <StatusBadge tone="success">Native curriculum</StatusBadge>
                  <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                    {reading.document?.title?.replace(/\s+libgenli$/i, '').slice(0, 64) || 'CFA curriculum'} · {reading.chunks.length} sections
                  </p>
                </div>
                <SegmentedControl
                  label="Reading source"
                  density="compact"
                  options={[
                    { value: 'curriculum', label: 'Curriculum' },
                    { value: 'lessons', label: 'Lessons' },
                  ]}
                  value={readingView}
                  onChange={setReadingView}
                />
              </div>
            </Surface>
          )}

          {readingView === 'curriculum' && reading.chunks.length > 0 ? (
            <>
              {reading.chunks.slice(0, chunkLimit).map((chunk) => (
                <Surface key={chunk.id} tone="study" className="animate-fade" style={{ marginBottom: 'var(--space-4)' }}>
                  <div className="flex-between qv-mb-2" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                    <h3 className="qv-m-0 qv-fs-md">{chunk.heading || reading.document?.title?.replace(/\s+libgenli$/i, '') || 'Curriculum'}</h3>
                    <StatusBadge tone="vault">{chunk.locator}</StatusBadge>
                  </div>
                  <p className="qv-m-0" style={{ whiteSpace: 'pre-line', lineHeight: 1.7 }}>{chunk.text}</p>
                </Surface>
              ))}
              {chunkLimit < reading.chunks.length && (
                <button
                  className="btn btn-secondary"
                  style={{ marginBottom: 'var(--space-6)' }}
                  onClick={() => setChunkLimit((limit) => limit + 6)}
                >
                  Show more curriculum ({reading.chunks.length - chunkLimit} sections left)
                </button>
              )}

              <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
                <div className="flex-between qv-mb-2" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
                  <div>
                    <StatusBadge tone="accent">AI summary</StatusBadge>
                    <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>3-4 paragraph exam-focused review of this topic.</p>
                  </div>
                  <button className="btn btn-secondary" onClick={handleSummarize} disabled={summaryState.state === 'loading'}>
                    {summaryState.state === 'loading' ? 'Summarizing…' : summaryState.text ? 'Regenerate summary' : 'Summarize'}
                  </button>
                </div>
                {summaryState.state === 'error' && (
                  <p className="qv-text-danger qv-m-0">{summaryState.error}</p>
                )}
                {summaryState.state === 'done' && summaryState.text && (
                  <p
                    style={{
                      margin: 'var(--space-3) 0 0',
                      padding: 'var(--space-3)',
                      borderLeft: '3px solid var(--accent)',
                      background: 'var(--surface-2, rgba(120,180,255,0.06))',
                      borderRadius: 'var(--radius-md, 8px)',
                      whiteSpace: 'pre-line',
                      lineHeight: 1.55,
                    }}
                  >
                    {summaryState.text}
                  </p>
                )}
              </Surface>

              <div style={{ marginBottom: 'var(--space-6)' }}>
                <PodcastPanel
                  level={level}
                  topic={topic}
                  title={data.title || 'Topic'}
                  sourceExcerpts={(reading?.chunks || []).slice(0, 6).map((c) => c.text).filter(Boolean)}
                />
              </div>

              <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
                <div className="flex-between qv-mb-2" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
                  <div>
                    <StatusBadge tone="accent">AI practice</StatusBadge>
                    <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>Generate questions from this curriculum with your local model.</p>
                  </div>
                  <button className="btn btn-primary" onClick={handleGenerate} disabled={aiState === 'loading'}>
                    {aiState === 'loading' ? 'Generating…' : aiQuestions.length ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                {aiState === 'error' && <p className="qv-text-danger qv-m-0">{aiError}</p>}
                {aiQuestions.map((question, qi) => (
                  <div key={question.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                    <strong>{qi + 1}. {question.question}</strong>
                    <ul style={{ margin: 'var(--space-2) 0', paddingLeft: 'var(--space-5)' }}>
                      {question.options.map((option, oi) => (
                        <li key={oi} style={{ color: oi === question.correct ? 'var(--success)' : 'var(--text-secondary)', fontWeight: oi === question.correct ? 700 : 400 }}>
                          {option}{oi === question.correct ? ' ✓' : ''}
                        </li>
                      ))}
                    </ul>
                    {question.explanation && <p className="qv-text-muted qv-fs-sm qv-m-0">{question.explanation}</p>}
                  </div>
                ))}
              </Surface>

              <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
                <div className="flex-between qv-mb-2" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
                  <div>
                    <StatusBadge tone="accent">AI flashcards</StatusBadge>
                    <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>Generate curriculum-grounded flashcards with your local model.</p>
                  </div>
                  <div className="qv-row-2">
                    {aiFlashState === 'loading' && (
                      <button className="btn btn-secondary" onClick={handleCancelFlashcards}>Cancel</button>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={handleGenerateFlashcards}
                      disabled={aiFlashState === 'loading'}
                    >
                      {aiFlashState === 'loading' ? 'Generating…' : aiFlashcards.length ? 'Regenerate' : 'Generate'}
                    </button>
                  </div>
                </div>
                {aiFlashState === 'loading' && (
                  <p className="muted-copy qv-m-0">Building flashcards from curriculum excerpts…</p>
                )}
                {aiFlashState === 'error' && (
                  <p className="qv-text-danger qv-m-0">{aiFlashError}</p>
                )}
                {aiFlashState === 'done' && aiFlashcards.length > 0 && (
                  <FlashcardDeck cards={aiFlashcards} />
                )}
              </Surface>

              <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
                <div className="qv-mb-2">
                  <StatusBadge tone="accent">Ask the curriculum</StatusBadge>
                  <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                    Grounded RAG over this topic's ingested volume via the embedded notebook — cited, source-only answers.
                  </p>
                </div>
                <div className="qv-row-2" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <input
                    className="input"
                    style={{ flex: '1 1 320px' }}
                    value={askQuestion}
                    onChange={(event) => setAskQuestion(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && askState !== 'loading') handleAskCurriculum(); }}
                    placeholder={`e.g. How does ${data.title} relate to exam vignettes?`}
                    aria-label="Ask a question grounded in this topic's curriculum"
                  />
                  <button className="btn btn-primary" onClick={handleAskCurriculum} disabled={askState === 'loading' || !askQuestion.trim()}>
                    {askState === 'loading' ? 'Thinking…' : 'Ask'}
                  </button>
                  {(hasSpeechRecognition() || hasMediaDevices) && (
                    <div className="qv-row-1">
                      {/* Mode toggle */}
                      <button
                        type="button"
                        className={`btn btn-sm ${voiceMode === 'browser' ? 'btn-secondary' : 'btn-ghost'}`}
                        onClick={() => setVoiceMode('browser')}
                        aria-pressed={voiceMode === 'browser'}
                        title="Browser (cloud) STT"
                        style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
                      >
                        Cloud
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${voiceMode === 'offline' ? 'btn-secondary' : 'btn-ghost'}`}
                        onClick={() => setVoiceMode('offline')}
                        aria-pressed={voiceMode === 'offline'}
                        title="Offline Whisper STT (on-device)"
                        style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
                      >
                        Offline
                      </button>
                    </div>
                  )}
                  {voiceMode === 'browser' && hasSpeechRecognition() && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleMicClick}
                      disabled={askState === 'loading'}
                      aria-label={voiceState === 'listening' ? 'Stop listening' : 'Dictate question'}
                      title={voiceState === 'listening' ? 'Stop listening' : 'Dictate question'}
                    >
                      {voiceState === 'listening' ? 'Listening…' : '🎤'}
                    </button>
                  )}
                  {voiceMode === 'offline' && hasMediaDevices && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleOfflineMicClick}
                      disabled={askState === 'loading'}
                      aria-label={
                        voiceState === 'recording'
                          ? 'Stop recording'
                          : voiceState === 'transcribing'
                          ? 'Transcribing…'
                          : 'Dictate question (offline Whisper)'
                      }
                      title="Offline Whisper STT — first use downloads ~40 MB model"
                    >
                      {voiceState === 'recording'
                        ? 'Recording…'
                        : voiceState === 'transcribing'
                        ? 'Transcribing…'
                        : '🎤 Offline (Whisper)'}
                    </button>
                  )}
                  {askState === 'loading' && (
                    <button className="btn btn-secondary" onClick={handleCancelAsk}>Cancel</button>
                  )}
                </div>
                {voiceMode === 'browser' && hasSpeechRecognition() && (
                  <p className="qv-fs-xs qv-text-muted" style={{ margin: 'var(--space-1) 0 0' }}>
                    Voice input may use the browser's network STT on Chrome — type to stay strictly offline.
                  </p>
                )}
                {voiceMode === 'offline' && hasMediaDevices && (
                  <p className="qv-fs-xs qv-text-muted" style={{ margin: 'var(--space-1) 0 0' }}>
                    First use downloads ~40 MB Whisper model; cached locally after.
                    {voiceProgress && voiceProgress.status === 'progress' && voiceProgress.progress != null && (
                      <> Downloading Whisper model… {Math.round(voiceProgress.progress)}%</>
                    )}
                  </p>
                )}
                {askState === 'loading' && (
                  <p className="muted-copy qv-mt-2">
                    Embedding curriculum and synthesizing a grounded answer — the first ask for a topic takes longer while sources index.
                  </p>
                )}
                {askState === 'error' && <p className="qv-text-danger qv-mt-2">{askError}</p>}
                {askState === 'cancelled' && (
                  <p className="muted-copy qv-mt-2">
                    Ask cancelled. Any previously saved answer is still on this topic.
                  </p>
                )}
                {askState === 'done' && askAnswer && (() => {
                  const { tokens, sourceIds } = parseCitations(askAnswer);
                  return (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                      <div style={{ whiteSpace: 'pre-line', lineHeight: 1.55 }}>
                        {tokens.map((token, ti) =>
                          token.kind === 'text' ? (
                            <span key={ti}>{token.text}</span>
                          ) : (
                            <sup key={ti} style={{ marginLeft: 2 }}>
                              {token.refs.map((n, ri) => (
                                <span
                                  key={n}
                                  title={`${sourceTitleMap?.get(sourceIds[n - 1]) || sourceIds[n - 1] || `Citation ${n}`}`}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minWidth: 18,
                                    padding: '0 4px',
                                    marginLeft: ri === 0 ? 0 : 2,
                                    fontSize: 'var(--fs-xs)',
                                    fontWeight: 600,
                                    borderRadius: 8,
                                    background: 'var(--accent-soft, rgba(120,180,255,0.18))',
                                    color: 'var(--accent, currentColor)',
                                    border: '1px solid var(--accent, transparent)',
                                  }}
                                >
                                  {n}
                                </span>
                              ))}
                            </sup>
                          ),
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                        {hasSpeechSynthesis() && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={handleSpeakClick}
                            aria-label={voiceState === 'speaking' ? 'Stop speaking' : 'Read answer aloud'}
                            title={voiceState === 'speaking' ? 'Stop speaking' : 'Read answer aloud'}
                          >
                            {voiceState === 'speaking' ? '⏹ Stop' : '🔊 Speak'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleSaveAskToNotes}
                          title="Append this Q&A to the topic's lesson note"
                        >
                          📌 Save Q&A to notes
                        </button>
                      </div>
                      {sourceIds.length > 0 && (
                        <ol style={{ marginTop: 'var(--space-3)', paddingLeft: 'var(--space-5)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
                          {sourceIds.map((id) => (
                            <li key={id} style={{ marginBottom: 'var(--space-1)' }}>
                              <strong className="qv-text-secondary">{sourceTitleMap?.get(id) || 'Curriculum source'}</strong>
                              <span style={{ marginLeft: 'var(--space-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-xs)' }}>{id}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  );
                })()}
                {askHistory.length > 1 && (
                  <details className="qv-mt-3">
                    <summary className="qv-fw-semibold" style={{ cursor: 'pointer' }}>
                      Previous asks on this topic ({askHistory.length - 1})
                    </summary>
                    <div className="qv-stack-3 qv-mt-2">
                      {askHistory.slice(1).map((entry, index) => (
                        <div
                          key={`${entry.answeredAt}-${index}`}
                          style={{
                            padding: 'var(--space-3)',
                            borderRadius: 'var(--radius-md, 8px)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <small className="muted-copy">{new Date(entry.answeredAt).toLocaleString()}</small>
                          <p style={{ margin: 'var(--space-1) 0 var(--space-2)', fontWeight: 600 }}>{entry.question}</p>
                          <p className="qv-m-0 qv-text-secondary" style={{ whiteSpace: 'pre-line' }}>
                            {entry.answer.length > 600 ? `${entry.answer.slice(0, 600)}…` : entry.answer}
                          </p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Surface>
            </>
          ) : (
            <>
              {data.sections.map((section, i) => (
                <Surface key={i} tone="study" className="animate-fade" style={{ marginBottom: 'var(--space-6)', animationDelay: `${i * 80}ms` }}>
                  <h2 style={{ marginTop: 0 }}>{section.title}</h2>
                  {section.content.split('\n\n').map((para, j) => (
                    <p key={j} style={{ whiteSpace: 'pre-line' }}>{para}</p>
                  ))}

                  {section.keyPoints && (
                    <div className="key-concept">
                      <h4><Lightbulb size={16} /> Key Points</h4>
                      <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                        {section.keyPoints.map((point, k) => (
                          <li key={k} style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--fs-sm)' }}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Surface>
              ))}
              {data.examples?.length > 0 && (
                <Surface tone="study" status="success" style={{ marginBottom: 'var(--space-6)' }}>
                  <h2 style={{ marginTop: 0 }}>Worked Examples</h2>
                  {data.examples.slice(0, 4).map((example) => (
                    <div key={example.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
                      <span className="badge badge-blue">{example.formulaName || 'concept'}</span>
                      <h3>{example.title}</h3>
                      <p>{example.prompt}</p>
                      <p className="qv-text-secondary">{example.walkthrough}</p>
                    </div>
                  ))}
                </Surface>
              )}
            </>
          )}
        </div>

        {/* Sidebar — Formulas */}
        <div className="study-sidebar">
          <Surface tone="study" density="compact">
            <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Target size={18} color="var(--accent)" /> Skill Labs
            </h3>
            <div className="vault-list">
              {data.skillLabs.map((lab) => (
                <Link key={lab.id} to={lab.path} className="vault-row" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div>
                    <span className="badge badge-purple">{lab.type}</span>
                    <h4>{lab.title}</h4>
                    <p>{lab.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </Surface>

          <Surface tone="study" density="compact">
            <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <BookOpen size={18} color="var(--accent)" /> Formula Reference
            </h3>
            {data.formulas && data.formulas.length > 0 ? (
              data.formulas.map((f, i) => (
                <FormulaBlock key={i} {...f} />
              ))
            ) : (
              <p className="qv-text-muted qv-fs-sm">No formulas for this topic.</p>
            )}
          </Surface>

          <SourceRail
            compact
            title="Source References"
            subtitle="Official-first snippets mapped to this lesson."
            target={{
              kind: 'module',
              domain: 'cfa',
              level,
              topicId: topic,
              pathway: level === 'level3' && pathwayScoped ? activePathway : undefined,
              title: data.title,
              objectiveIds: data.learningObjectives.map((objective) => objective.id),
              formulaNames: data.formulas?.map((formula) => formula.name) || [],
              keywords: [
                ...data.learningObjectives.map((objective) => objective.title),
                ...data.sections.map((section) => section.title),
              ],
              route: `/cfa/${level}/${topic}`,
            }}
          />

          <Surface tone="vault" density="compact">
            <div className="flex-between qv-mb-3">
              <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <StickyNote size={18} color="var(--accent)" /> Local Notes
              </h3>
              <button className={`btn ${bookmarked ? 'btn-primary' : 'btn-secondary'}`} onClick={handleToggleBookmark}>
                <Bookmark size={16} /> {bookmarked ? 'Saved' : 'Bookmark'}
              </button>
            </div>
            <textarea
              value={noteBody}
              onChange={(event) => setNoteBody(event.target.value)}
              placeholder="Capture formulas, traps, or review prompts..."
              aria-label={`${data.title} local note`}
              style={{
                width: '100%',
                minHeight: 132,
                resize: 'vertical',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
                padding: 'var(--space-3)',
                lineHeight: 1.5,
              }}
            />
            <div className="flex-between qv-mt-3" style={{ gap: 'var(--space-3)' }}>
              <span className="qv-text-muted qv-fs-xs">
                {noteSavedAt ? `Saved ${new Date(noteSavedAt).toLocaleString()}` : 'Stored locally on this device'}
              </span>
              <button className="btn btn-primary" onClick={handleSaveNote}>Save Note</button>
            </div>
          </Surface>

          <Link
            to={`/cfa/${level}/${topic}/quiz`}
            className="surface surface-study surface-interactive"
            style={{
              textDecoration: 'none', color: 'inherit',
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
              background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.2)',
            }}
          >
            <Target size={20} color="var(--accent)" />
            <div>
              <div className="qv-fw-semibold">Practice Quiz</div>
              <div className="qv-fs-xs qv-text-muted">Test your understanding</div>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
          </Link>
        </div>
      </div>
    </div>
  );
}
