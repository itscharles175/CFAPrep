import { useEffect, useState } from 'react';
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
import { generateQuestionsFromCurriculum, getCachedGeneratedQuestions, getLlmSettings, saveCachedGeneratedQuestions } from '../../lib/localLlm';
import { askGrounded, ensureTopicNotebook, getCachedGroundedAnswer, getOpenNotebookSettings, saveCachedGroundedAnswer } from '../../lib/openNotebook';

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
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askState, setAskState] = useState('idle');
  const [askError, setAskError] = useState('');

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

  // Rehydrate the last grounded Q&A for this topic so it survives navigation.
  useEffect(() => {
    let cancelled = false;
    if (!topic) return undefined;
    getCachedGroundedAnswer(level, topic).then((cached) => {
      if (cancelled) return;
      setAskQuestion(cached?.question || '');
      setAskAnswer(cached?.answer || '');
      setAskState(cached?.answer ? 'done' : 'idle');
      setAskError('');
    });
    return () => {
      cancelled = true;
    };
  }, [level, topic]);

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

  // Grounded RAG: ask the embedded open-notebook backend a question answered
  // strictly from this topic's ingested curriculum (cited synthesis).
  async function handleAskCurriculum() {
    const question = askQuestion.trim();
    if (!question) return;
    setAskState('loading');
    setAskError('');
    setAskAnswer('');
    try {
      const settings = await getOpenNotebookSettings();
      if (!settings.enabled) {
        setAskState('error');
        setAskError('Enable the embedded notebook in System Health → Embedded Notebook first.');
        return;
      }
      await ensureTopicNotebook({
        baseUrl: settings.baseUrl,
        topicKey: `${level}:${topic}`,
        topicTitle: data.title,
        // Seed the whole topic — open-notebook re-chunks + embeds + retrieves
        // by relevance, so partial seeds force "not enough info" responses on
        // questions about deeper sections (front-matter only otherwise).
        seedChunks: reading.chunks,
      });
      // Why askGrounded (global ask/simple) instead of chatWithSource
      // (per-source chat): the global endpoint runs full RAG retrieval on the
      // source embeddings and produces content-rich, cited answers. Per-source
      // chat is structurally scoped but uses open-notebook insights (separately
      // generated by transformations) for retrieval, so without insight
      // generation it answers from the source title only. The chatWithSource
      // primitive is kept in the lib for the future once insights wiring lands.
      const result = await askGrounded({ baseUrl: settings.baseUrl, question });
      const answer = result.answer || 'No answer was returned.';
      setAskAnswer(answer);
      setAskState('done');
      await saveCachedGroundedAnswer(level, topic, { question, answer });
    } catch (error) {
      setAskState('error');
      setAskError(error instanceof Error ? error.message : 'Grounded answer failed.');
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
            <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
              <h2 style={{ margin: 0 }}>Objective Rail</h2>
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
                  <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-2)', alignItems: 'flex-start' }}>
                    <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>{chunk.heading || reading.document?.title?.replace(/\s+libgenli$/i, '') || 'Curriculum'}</h3>
                    <StatusBadge tone="vault">{chunk.locator}</StatusBadge>
                  </div>
                  <p style={{ whiteSpace: 'pre-line', lineHeight: 1.7, margin: 0 }}>{chunk.text}</p>
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
                <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                  <div>
                    <StatusBadge tone="accent">AI practice</StatusBadge>
                    <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>Generate questions from this curriculum with your local model.</p>
                  </div>
                  <button className="btn btn-primary" onClick={handleGenerate} disabled={aiState === 'loading'}>
                    {aiState === 'loading' ? 'Generating…' : aiQuestions.length ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                {aiState === 'error' && <p style={{ color: 'var(--danger)', margin: 0 }}>{aiError}</p>}
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
                    {question.explanation && <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>{question.explanation}</p>}
                  </div>
                ))}
              </Surface>

              <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ marginBottom: 'var(--space-2)' }}>
                  <StatusBadge tone="accent">Ask the curriculum</StatusBadge>
                  <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                    Grounded RAG over this topic's ingested volume via the embedded notebook — cited, source-only answers.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
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
                </div>
                {askState === 'loading' && (
                  <p className="muted-copy" style={{ marginTop: 'var(--space-2)' }}>
                    Embedding curriculum and synthesizing a grounded answer — the first ask for a topic takes longer while sources index.
                  </p>
                )}
                {askState === 'error' && <p style={{ color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{askError}</p>}
                {askState === 'done' && askAnswer && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-3)', whiteSpace: 'pre-line' }}>
                    {askAnswer}
                  </div>
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
                      <p style={{ color: 'var(--text-secondary)' }}>{example.walkthrough}</p>
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
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>No formulas for this topic.</p>
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
            <div className="flex-between" style={{ marginBottom: 'var(--space-3)' }}>
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
            <div className="flex-between" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-3)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
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
              <div style={{ fontWeight: 600 }}>Practice Quiz</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Test your understanding</div>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
          </Link>
        </div>
      </div>
    </div>
  );
}
