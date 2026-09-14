import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpenCheck, BookText, ChevronDown, MessageSquareText, ShieldCheck } from 'lucide-react';
import {
  CitationPanel,
  NotesPanel,
  ReaderPane,
  SourceNavigator,
  TutorPanel,
  type NoteKind,
  type TutorCitation,
  type TutorReaderContent,
  type TutorSource,
  type TutorTurn,
} from '../components/TutorWorkspace';
import { getCfaSourceChunks, getCfaSourceDocuments } from '../lib/cfaSourceVault';
import { getNote, getNotes, saveNote } from '../lib/learning';
import { getLlmSettings } from '../lib/localLlm';
import { localGroundedAnswer } from '../lib/localRag';
import {
  chatWithSource,
  getOpenNotebookSettings,
  listSources,
  type OnbSource,
} from '../lib/openNotebook';
import { parseCitations } from '../lib/citations';
import type { CfaSourceDocument } from '../lib/cfaSourceTypes';
import './TutorWorkspace.css';

type TutorState = 'idle' | 'running' | 'success' | 'cancelled' | 'error' | 'saving' | 'saved' | 'save-error';
type NoteState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
type MobilePane = 'sources' | 'read' | 'ask';

function coverageFor(document: CfaSourceDocument): TutorSource['coverage'] {
  if (document.needsOcr || document.chunkCount === 0) return 'missing';
  if (!document.topicIds.length) return 'partial';
  return 'ready';
}

function sourceFromCfa(document: CfaSourceDocument): TutorSource {
  const builtIn = document.sourceKind === 'official-curriculum' || document.canonical;
  return {
    id: `cfa:${document.id}`,
    title: document.title,
    subtitle: [document.level.replace('level', 'Level '), document.publisher, `${document.chunkCount} sections`].filter(Boolean).join(' · '),
    provenance: builtIn ? 'built-in' : 'imported',
    coverage: coverageFor(document),
    kind: 'cfa-document',
    document,
  };
}

function sourceFromNotebook(source: OnbSource): TutorSource {
  return {
    id: `notebook:${source.id}`,
    title: source.title || 'Untitled notebook source',
    subtitle: 'Embedded notebook · retrieved on demand',
    provenance: 'imported',
    coverage: 'unknown',
    kind: 'notebook-source',
  };
}

function noteKey(sourceId: string, kind: NoteKind) {
  return `tutor-${kind}:${sourceId}`;
}

function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Request cancelled.';
  if (error instanceof Error) return error.message;
  return 'The local tutor could not complete this request.';
}

function renderParsedAnswer(answer: string): { answer: string; sourceIds: string[] } {
  const parsed = parseCitations(answer);
  return {
    answer: parsed.tokens.map((token) => token.kind === 'text' ? token.text : token.refs.map((ref) => `[${ref}]`).join('')).join(''),
    sourceIds: parsed.sourceIds,
  };
}

export default function TutorWorkspace() {
  const [sources, setSources] = useState<TutorSource[]>([]);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sourceError, setSourceError] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reader, setReader] = useState<TutorReaderContent>({ chunks: [], state: 'idle' });
  const [question, setQuestion] = useState('');
  const [turn, setTurn] = useState<TutorTurn | null>(null);
  const [tutorState, setTutorState] = useState<TutorState>('idle');
  const [tutorError, setTutorError] = useState('');
  const [citation, setCitation] = useState<TutorCitation | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('read');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const mobileTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [noteKind, setNoteKind] = useState<NoteKind>('notes');
  const [notes, setNotes] = useState<Record<NoteKind, string>>({ notes: '', annotations: '' });
  const [noteState, setNoteState] = useState<NoteState>('idle');
  const [noteError, setNoteError] = useState('');

  const selectedSource = useMemo(() => sources.find((source) => source.id === selectedId) || null, [selectedId, sources]);
  const filteredSources = useMemo(() => {
    const terms = sourceQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return sources;
    return sources.filter((source) => terms.every((term) => `${source.title} ${source.subtitle} ${source.provenance}`.toLowerCase().includes(term)));
  }, [sourceQuery, sources]);

  const loadSources = useCallback(async () => {
    setSourceState('loading');
    setSourceError('');
    try {
      const [documents, openNotebookSettings, savedNotes] = await Promise.all([
        getCfaSourceDocuments(),
        getOpenNotebookSettings(),
        getNotes(),
      ]);
      let notebookSources: OnbSource[] = [];
      if (openNotebookSettings.enabled) {
        notebookSources = await listSources({ baseUrl: openNotebookSettings.baseUrl }).catch(() => []);
      }
      const generated = savedNotes
        .filter((note) => note.type === 'general' && note.moduleId?.startsWith('tutor-response:'))
        .map<TutorSource>((note) => ({
          id: `generated:${note.id}`,
          title: note.title,
          subtitle: `Saved tutor response · ${new Date(note.updatedAt).toLocaleDateString()}`,
          provenance: 'generated',
          coverage: 'partial',
          kind: 'generated-note',
          generatedBody: note.body,
        }));
      const next = [...documents.map(sourceFromCfa), ...notebookSources.map(sourceFromNotebook), ...generated];
      setSources(next);
      setSelectedId((current) => current && next.some((source) => source.id === current) ? current : next[0]?.id || null);
      setSourceState('ready');
    } catch (error) {
      setSourceState('error');
      setSourceError(friendlyError(error));
    }
  }, []);

  useEffect(() => {
    void loadSources();
    return () => abortRef.current?.abort();
  }, [loadSources]);

  useEffect(() => {
    let active = true;
    setCitation(null);
    setTurn(null);
    setTutorState('idle');
    setQuestion('');
    setReader({ chunks: [], state: selectedSource ? 'loading' : 'idle' });
    setNotes({ notes: '', annotations: '' });
    setNoteState('idle');
    if (!selectedSource) return () => { active = false; };

    const noteTarget = (kind: NoteKind) => ({ type: 'general' as const, domain: 'cfa' as const, moduleId: noteKey(selectedSource.id, kind) });
    Promise.all([
      selectedSource.kind === 'cfa-document' && selectedSource.document
        ? getCfaSourceChunks(selectedSource.document.id)
        : Promise.resolve([]),
      getNote(noteTarget('notes')),
      getNote(noteTarget('annotations')),
    ]).then(([chunks, sourceNotes, sourceAnnotations]) => {
      if (!active) return;
      setReader({ chunks, state: selectedSource.kind === 'cfa-document' ? (chunks.length ? 'ready' : 'empty') : 'ready' });
      setNotes({ notes: sourceNotes?.body || '', annotations: sourceAnnotations?.body || '' });
    }).catch((error) => {
      if (!active) return;
      setReader({ chunks: [], state: 'error', error: friendlyError(error) });
    });
    return () => { active = false; };
  }, [selectedSource]);

  async function askTutor() {
    if (!selectedSource || !question.trim()) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setTutorState('running');
    setTutorError('');
    setCitation(null);
    const cleanQuestion = question.trim();
    try {
      let answer = '';
      let citations: TutorCitation[] = [];
      if (selectedSource.kind === 'notebook-source') {
        const settings = await getOpenNotebookSettings();
        if (!settings.enabled) throw new Error('Enable the embedded notebook in System Health before asking from this source.');
        const sourceId = selectedSource.id.replace(/^notebook:/, '');
        const result = await chatWithSource({ baseUrl: settings.baseUrl, sourceId, message: cleanQuestion, signal: controller.signal });
        const parsed = renderParsedAnswer(result.answer);
        answer = parsed.answer;
        const citedIds = parsed.sourceIds.length ? parsed.sourceIds : result.citationSources;
        citations = citedIds.map((id, index) => ({
          id: `${sourceId}:${id}:${index}`,
          number: index + 1,
          sourceId: id,
          title: id === sourceId ? selectedSource.title : id,
          provenance: 'imported',
        }));
      } else if (selectedSource.kind === 'cfa-document' && selectedSource.document) {
        const llmSettings = await getLlmSettings();
        if (!llmSettings.enabled) throw new Error('Enable a local model in System Health to ask questions from curriculum sources.');
        const topic = selectedSource.document.topicIds[0];
        if (!topic) throw new Error('This source has no topic coverage tag, so the tutor cannot retrieve it safely. Add coverage in Library first.');
        const result = await localGroundedAnswer({
          question: cleanQuestion,
          domain: 'cfa',
          level: selectedSource.document.level,
          topic,
          settings: llmSettings,
          signal: controller.signal,
        });
        answer = result.answer;
        citations = result.grounded === false ? [] : result.citations.map((row) => ({
          id: `${row.documentId}:${row.number}`,
          number: row.number,
          sourceId: row.documentId,
          title: row.documentId === selectedSource.document?.id ? selectedSource.title : row.documentId,
          locator: row.locator,
          snippet: row.snippet,
          provenance: selectedSource.provenance,
        }));
      } else {
        throw new Error('Saved tutor responses are reference material, but they cannot ground a new answer. Choose a curriculum or imported source.');
      }
      if (controller.signal.aborted) return;
      setTurn({ id: `tutor-${Date.now()}`, question: cleanQuestion, answer, citations, sourceId: selectedSource.id, createdAt: new Date().toISOString() });
      setTutorState('success');
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setTutorState('cancelled');
      } else {
        setTutorState('error');
        setTutorError(friendlyError(error));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function cancelTutor() {
    abortRef.current?.abort();
    abortRef.current = null;
    setTutorState('cancelled');
  }

  async function saveTutorTurn() {
    if (!turn || !selectedSource) return;
    setTutorState('saving');
    setTutorError('');
    try {
      const citationText = turn.citations.map((item) => `[${item.number}] ${item.title}${item.locator ? ` — ${item.locator}` : ''}`).join('\n');
      await saveNote({
        type: 'general',
        domain: 'cfa',
        moduleId: `tutor-response:${turn.id}`,
        title: `Tutor: ${turn.question.slice(0, 72)}`,
        body: `Question\n${turn.question}\n\nAnswer\n${turn.answer}\n\nSources\n${citationText || 'Unsupported — no citations returned.'}`,
        path: '/tutor',
      });
      setTutorState('saved');
    } catch (error) {
      setTutorState('save-error');
      setTutorError(friendlyError(error));
    }
  }

  async function saveSourceWriting() {
    if (!selectedSource) return;
    setNoteState('saving');
    setNoteError('');
    try {
      await saveNote({
        type: 'general',
        domain: 'cfa',
        moduleId: noteKey(selectedSource.id, noteKind),
        title: `${noteKind === 'notes' ? 'Notes' : 'Annotations'} · ${selectedSource.title}`,
        body: notes[noteKind],
        path: '/tutor',
      });
      setNoteState('saved');
    } catch (error) {
      setNoteState('error');
      setNoteError(friendlyError(error));
    }
  }

  function selectSource(source: TutorSource) {
    setSelectedId(source.id);
    setSourcesOpen(false);
    setMobilePane('read');
  }

  return (
    <div className="tutor-workspace-page">
      <header className="tutor-workspace-hero">
        <div>
          <span className="tutor-hero-mark"><BookOpenCheck size={16} aria-hidden="true" /> Learn · Source studio</span>
          <h1>Read closely. Ask precisely.</h1>
          <p>Read, annotate, and ask a cited local tutor without leaving your source.</p>
        </div>
        <span className="tutor-local-pill"><ShieldCheck size={14} aria-hidden="true" /> Private · local only</span>
      </header>

      <nav className="tutor-mobile-tabs" role="tablist" aria-label="Tutor workspace panes">
        {([
          ['sources', 'Sources'],
          ['read', 'Read'],
          ['ask', 'Ask'],
        ] as const).map(([pane, label], index, panes) => (
          <button
            key={pane}
            ref={(node) => { mobileTabRefs.current[index] = node; }}
            id={`tutor-${pane}-tab`}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane}
            tabIndex={mobilePane === pane ? 0 : -1}
            onClick={() => setMobilePane(pane)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? panes.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + panes.length) % panes.length;
              const nextPane = panes[nextIndex][0];
              setMobilePane(nextPane);
              mobileTabRefs.current[nextIndex]?.focus();
            }}
          >{label}</button>
        ))}
      </nav>

      <main className="tutor-workspace-shell">
        <div className="tutor-source-toolbar">
          <button
            type="button"
            className="tutor-source-trigger"
            aria-expanded={sourcesOpen}
            aria-controls="tutor-source-drawer"
            onClick={() => setSourcesOpen((open) => !open)}
          >
            <BookText size={16} aria-hidden="true" />
            <span><small>Current source</small><strong>{selectedSource?.title || 'Choose a source'}</strong></span>
            <span className="tutor-source-trigger-count">{sources.length}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <span><MessageSquareText size={14} aria-hidden="true" /> Answers stay constrained to the selected source.</span>
        </div>

        <div id="tutor-source-drawer" role="tabpanel" aria-labelledby="tutor-sources-tab" className="tutor-source-drawer" data-open={sourcesOpen} data-mobile-active={mobilePane === 'sources'}>
          <SourceNavigator
            sources={filteredSources}
            selectedId={selectedId}
            query={sourceQuery}
            onQueryChange={setSourceQuery}
            onSelect={selectSource}
            loading={sourceState === 'loading'}
            error={sourceState === 'error' ? sourceError : undefined}
          />
        </div>

        {sourceState === 'ready' && sources.length === 0 ? (
          <section className="tutor-workspace-empty" data-mobile-active={mobilePane !== 'sources'}>
            <BookOpenCheck size={26} aria-hidden="true" />
            <h2>Bring in one trusted source.</h2>
            <p>Import a readable document to start reading, annotating, and asking grounded questions.</p>
            <Link className="btn btn-primary" to="/vault">Import a source</Link>
          </section>
        ) : (
          <div className="tutor-primary-columns">
            <div id="tutor-read-panel" role="tabpanel" aria-labelledby="tutor-read-tab" className="tutor-center-column" data-mobile-active={mobilePane === 'read'}>
              <ReaderPane source={selectedSource} content={reader} activeLocator={citation?.locator} />
              {selectedSource && (
                <details className="tutor-writing-drawer">
                  <summary>Notes &amp; annotations <span>{noteState === 'dirty' ? 'Unsaved' : noteState === 'saved' ? 'Saved' : ''}</span></summary>
                  <NotesPanel
                    active={noteKind}
                    onActiveChange={(kind) => { setNoteKind(kind); setNoteState('idle'); }}
                    value={notes[noteKind]}
                    onChange={(value) => { setNotes((current) => ({ ...current, [noteKind]: value })); setNoteState('dirty'); }}
                    onSave={() => void saveSourceWriting()}
                    onRetry={() => void saveSourceWriting()}
                    state={noteState}
                    error={noteError}
                    disabled={!selectedSource}
                  />
                </details>
              )}
            </div>
            <div id="tutor-ask-panel" role="tabpanel" aria-labelledby="tutor-ask-tab" className="tutor-tutor-column" data-mobile-active={mobilePane === 'ask'}>
              <TutorPanel
                source={selectedSource}
                question={question}
                onQuestionChange={setQuestion}
                onAsk={() => void askTutor()}
                onCancel={cancelTutor}
                onRetry={() => void askTutor()}
                onSave={() => void saveTutorTurn()}
                onCitationSelect={setCitation}
                activeCitationId={citation?.id}
                turn={turn}
                state={tutorState}
                error={tutorError}
              />
            </div>
          </div>
        )}
      </main>
      <CitationPanel citation={citation} onClose={() => setCitation(null)} />
    </div>
  );
}
