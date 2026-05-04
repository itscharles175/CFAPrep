import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, Database, Filter, Search, StickyNote, Trash2 } from 'lucide-react';
import { PageHeader, MetricCard, SegmentedControl } from '../components/ui/Primitives';
import {
  deleteNote,
  getBookmarks,
  getNotes,
  getResultArtifacts,
  saveNote,
  toggleBookmark,
} from '../lib/learning';

const filters = [
  { value: 'all', label: 'All' },
  { value: 'lesson', label: 'Lessons' },
  { value: 'formula', label: 'Formulas' },
  { value: 'question', label: 'Questions' },
  { value: 'artifact', label: 'Artifacts' },
  { value: 'general', label: 'General' },
];

function matchesQuery(row, query) {
  if (!query) return true;
  const haystack = [row.title, row.body, row.summary, row.path, row.type, row.topic, row.formulaName, row.questionId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export default function VaultCenter() {
  const [notes, setNotes] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [editingNote, setEditingNote] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [message, setMessage] = useState('');

  async function refresh() {
    const [nextNotes, nextBookmarks, nextArtifacts] = await Promise.all([getNotes(), getBookmarks(), getResultArtifacts()]);
    setNotes(nextNotes);
    setBookmarks(nextBookmarks);
    setArtifacts(nextArtifacts);
  }

  useEffect(() => {
    let active = true;
    Promise.all([getNotes(), getBookmarks(), getResultArtifacts()]).then(([nextNotes, nextBookmarks, nextArtifacts]) => {
      if (!active) return;
      setNotes(nextNotes);
      setBookmarks(nextBookmarks);
      setArtifacts(nextArtifacts);
    });
    return () => {
      active = false;
    };
  }, []);

  const filteredNotes = useMemo(
    () => (filter === 'all' ? notes : notes.filter((note) => note.type === filter)).filter((note) => matchesQuery(note, query)),
    [filter, notes, query],
  );
  const filteredBookmarks = useMemo(
    () => (filter === 'all' ? bookmarks : bookmarks.filter((bookmark) => bookmark.type === filter)).filter((bookmark) => matchesQuery(bookmark, query)),
    [bookmarks, filter, query],
  );
  const filteredArtifacts = useMemo(
    () => artifacts.filter((artifact) => (filter === 'all' || filter === 'artifact') && matchesQuery(artifact, query)),
    [artifacts, filter, query],
  );

  function startEdit(note) {
    setEditingNote(note);
    setEditBody(note.body);
  }

  async function saveEdit() {
    if (!editingNote) return;
    await saveNote({ ...editingNote, body: editBody });
    setEditingNote(null);
    setEditBody('');
    setMessage('Note updated.');
    refresh();
  }

  async function createArtifactNote(artifact) {
    await saveNote({
      type: 'artifact',
      domain: artifact.domain,
      title: artifact.title,
      body: `${artifact.summary}\n\nAssumptions: ${JSON.stringify(artifact.assumptions)}\nMetrics: ${JSON.stringify(artifact.metrics)}`,
      path: artifact.path,
      artifactId: artifact.id,
    });
    setMessage('Artifact note created.');
    refresh();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'note') await deleteNote(pendingDelete.row);
    if (pendingDelete.kind === 'bookmark') await toggleBookmark(pendingDelete.row);
    setPendingDelete(null);
    setMessage('Vault item removed.');
    refresh();
  }

  return (
    <div className="page-container">
      <PageHeader
        badge="LOCAL VAULT"
        title="Notes, Bookmarks & Artifacts"
        subtitle="Search, edit, backlink, and manage your local study vault across lessons, formulas, questions, and tool outputs."
      />

      {pendingDelete && (
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm vault deletion">
          <div className="glass-card no-hover confirm-dialog-card">
            <h2>Remove Local Vault Item</h2>
            <p style={{ color: 'var(--text-secondary)' }}>
              Remove "{pendingDelete.row.title}" from this browser profile? This affects only local data.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmDelete}>Remove</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="Notes" value={notes.length} detail="Saved locally" icon={StickyNote} />
        <MetricCard label="Bookmarks" value={bookmarks.length} detail="Marked lessons and questions" icon={Bookmark} tone="warning" />
        <MetricCard label="Artifacts" value={artifacts.length} detail="Calculator and lab outputs" icon={Database} tone="accent" />
        <MetricCard label="Filter" value={filter} detail="Current vault slice" icon={Filter} tone="success" />
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <label className="vault-search">
          <Search size={16} />
          <input
            aria-label="Search local vault"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, bookmarks, formulas, questions, artifacts..."
          />
        </label>
      </div>

      <SegmentedControl label="Vault filter" options={filters} value={filter} onChange={setFilter} />
      {message && <p style={{ color: 'var(--text-secondary)' }}>{message}</p>}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Notes</h3>
          <div className="vault-list">
            {filteredNotes.length ? (
              filteredNotes.map((note) => (
                <div key={note.id} className="vault-row">
                  <div style={{ flex: 1 }}>
                    <span className="badge badge-blue">{note.type}</span>
                    <h4>{note.title}</h4>
                    {editingNote?.id === note.id ? (
                      <div>
                        <textarea
                          aria-label={`Edit ${note.title}`}
                          value={editBody}
                          onChange={(event) => setEditBody(event.target.value)}
                          style={{ width: '100%', minHeight: 120, resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                          <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingNote(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <p>{note.body}</p>
                    )}
                    {note.path && <Link to={note.path}>Open source</Link>}
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(note)}>Edit</button>
                    <button className="btn-icon btn-ghost" title="Delete note" onClick={() => setPendingDelete({ kind: 'note', row: note })}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--text-secondary)' }}>No notes match this vault slice.</p>
            )}
          </div>
        </div>

        <div className="glass-card no-hover">
          <h3 style={{ marginTop: 0 }}>Bookmarks</h3>
          <div className="vault-list">
            {filteredBookmarks.length ? (
              filteredBookmarks.map((bookmark) => (
                <div key={bookmark.id} className="vault-row">
                  <div>
                    <span className="badge badge-purple">{bookmark.type}</span>
                    <h4>{bookmark.title}</h4>
                    <Link to={bookmark.path}>Open source</Link>
                  </div>
                  <button className="btn-icon btn-ghost" title="Remove bookmark" onClick={() => setPendingDelete({ kind: 'bookmark', row: bookmark })}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--text-secondary)' }}>No bookmarks match this vault slice.</p>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card no-hover" style={{ marginTop: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Result Artifacts</h3>
        <div className="vault-list">
          {filteredArtifacts.length ? (
            filteredArtifacts.map((artifact) => (
              <div key={artifact.id} className="vault-row">
                <div>
                  <span className="badge badge-gold">{artifact.type}</span>
                  <h4>{artifact.title}</h4>
                  <p>{artifact.summary}</p>
                  {artifact.path && <Link to={artifact.path}>Open tool</Link>}
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => createArtifactNote(artifact)}>Send to Notes</button>
              </div>
            ))
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>No artifacts match this vault slice.</p>
          )}
        </div>
      </div>
    </div>
  );
}
