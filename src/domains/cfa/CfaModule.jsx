import { useEffect, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { loadCfaTopicContent } from './cfaLoaders';
import { level3PathwayForTopic } from './cfaLevel3Pathways';
import { useLevel3Pathway } from './useLevel3Pathway';
import { ArrowLeft, Target, BookOpen, Lightbulb, ChevronRight, Bookmark, StickyNote, Layers, PenLine } from 'lucide-react';
import FormulaBlock from '../../components/FormulaBlock';
import { useModuleProgress } from '../../hooks/useProgress';
import { getBookmark, getNote, saveNote, toggleBookmark } from '../../lib/learning';
import { EmptyPanel, PageHeader, ProgressRail, StatusBadge, Surface } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';

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
