import { useEffect, useState } from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { getCfaTopicContent } from './cfaLevels';
import { ArrowLeft, Target, BookOpen, Lightbulb, ChevronRight, Bookmark, StickyNote, Layers, PenLine } from 'lucide-react';
import FormulaBlock from '../../components/FormulaBlock';
import { useModuleProgress } from '../../hooks/useProgress';
import { getBookmark, getNote, saveNote, toggleBookmark } from '../../lib/learning';

export default function CfaModule() {
  const { level, topic } = useParams();
  const location = useLocation();
  const data = getCfaTopicContent(level, topic);
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

  if (!data) {
    return (
      <div className="page-container">
        <div className="glass-card no-hover" style={{ textAlign: 'center', padding: 'var(--space-16)' }}>
          <h2 style={{ marginBottom: 'var(--space-4)' }}>Module Coming Soon</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
            This topic is currently being developed. Check back soon!
          </p>
          <Link to="/cfa" className="btn btn-primary">← Back to CFA Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Link to="/cfa" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-4)' }}>
          <ArrowLeft size={16} /> Back to CFA Dashboard
        </Link>
        <div className="flex-between">
          <div>
            <div className="badge badge-gold" style={{ marginBottom: 'var(--space-2)' }}>
              {level?.replace('level', 'Level ')} · Weight: {data.weight}
            </div>
            {data.runtimeMode === 'validated-beta' && (
              <div className="badge badge-amber" style={{ marginBottom: 'var(--space-2)' }}>
                Validated authored beta · not public exam-ready
              </div>
            )}
            <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>{data.title}</h1>
            <p className="section-subtitle" style={{ marginBottom: 0 }}>
              {data.learningObjectives.length} objectives · {data.questions.length} questions · {data.vignettes.length} vignettes · {data.flashcards.length} cards
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
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
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 'var(--space-8)', alignItems: 'start' }}>
        {/* Main Content */}
        <div className="module-content">
          {data.sections.map((section, i) => (
            <div key={i} className="glass-card no-hover animate-fade" style={{ marginBottom: 'var(--space-6)', animationDelay: `${i * 80}ms` }}>
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
            </div>
          ))}
          {data.examples?.length > 0 && (
            <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
              <h2 style={{ marginTop: 0 }}>Worked Examples</h2>
              {data.examples.slice(0, 4).map((example) => (
                <div key={example.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
                  <span className="badge badge-blue">{example.formulaName || 'concept'}</span>
                  <h3>{example.title}</h3>
                  <p>{example.prompt}</p>
                  <p style={{ color: 'var(--text-secondary)' }}>{example.walkthrough}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sidebar — Formulas */}
        <div style={{ position: 'sticky', top: 'calc(var(--topbar-height) + var(--space-8))' }}>
          <div className="glass-card no-hover">
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
          </div>

          <div className="glass-card no-hover" style={{ marginTop: 'var(--space-4)' }}>
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
          </div>

          <div className="glass-card no-hover" style={{ marginTop: 'var(--space-4)' }}>
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
          </div>

          <Link
            to={`/cfa/${level}/${topic}/quiz`}
            className="glass-card"
            style={{
              marginTop: 'var(--space-4)', textDecoration: 'none', color: 'inherit',
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
