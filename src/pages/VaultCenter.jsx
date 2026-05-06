import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookText, Bookmark, Database, FileUp, Search, ShieldCheck, StickyNote, Trash2 } from 'lucide-react';
import { Dialog, InlineCluster, PageHeader, MetricCard, Panel, SegmentedControl, StatusBadge, Surface } from '../components/ui/Primitives';
import {
  deleteNote,
  getBookmarks,
  getNotes,
  getResultArtifacts,
  saveNote,
  toggleBookmark,
} from '../lib/learning';
import { parseJsonFile } from '../lib/jsonFilePreflight';
import {
  deleteAllCfaSourceVault,
  deleteCfaSourceDocument,
  getCfaSourceCoverageMap,
  getCfaSourceDocuments,
  getCfaSourceMapStatus,
  importCfaSourceBundle,
  searchCfaSourceVault,
} from '../lib/cfaSourceVault';
import { SourceLinkManager, SourceMapStatus } from '../components/SourceContext';

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
  const [searchParams] = useSearchParams();
  const [notes, setNotes] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [editingNote, setEditingNote] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [message, setMessage] = useState('');
  const [sourceDocuments, setSourceDocuments] = useState([]);
  const [sourceCoverage, setSourceCoverage] = useState(null);
  const [sourceQuery, setSourceQuery] = useState(searchParams.get('sourceQuery') || '');
  const [sourceResults, setSourceResults] = useState([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceMapStatus, setSourceMapStatus] = useState(null);
  const focusedChunk = searchParams.get('chunk');

  async function refresh() {
    const [nextNotes, nextBookmarks, nextArtifacts, nextSourceDocuments, nextSourceCoverage, nextSourceMapStatus] = await Promise.all([
      getNotes(),
      getBookmarks(),
      getResultArtifacts(),
      getCfaSourceDocuments(),
      getCfaSourceCoverageMap(),
      getCfaSourceMapStatus(),
    ]);
    setNotes(nextNotes);
    setBookmarks(nextBookmarks);
    setArtifacts(nextArtifacts);
    setSourceDocuments(nextSourceDocuments);
    setSourceCoverage(nextSourceCoverage);
    setSourceMapStatus(nextSourceMapStatus);
  }

  useEffect(() => {
    let active = true;
    Promise.all([getNotes(), getBookmarks(), getResultArtifacts(), getCfaSourceDocuments(), getCfaSourceCoverageMap(), getCfaSourceMapStatus()]).then(([nextNotes, nextBookmarks, nextArtifacts, nextSourceDocuments, nextSourceCoverage, nextSourceMapStatus]) => {
      if (!active) return;
      setNotes(nextNotes);
      setBookmarks(nextBookmarks);
      setArtifacts(nextArtifacts);
      setSourceDocuments(nextSourceDocuments);
      setSourceCoverage(nextSourceCoverage);
      setSourceMapStatus(nextSourceMapStatus);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!sourceQuery.trim()) {
      Promise.resolve().then(() => {
        if (!cancelled) setSourceResults([]);
      });
      return () => {
        cancelled = true;
      };
    }
    searchCfaSourceVault(sourceQuery, 8).then((results) => {
      if (!cancelled) setSourceResults(results);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceQuery]);

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
  const sourceMapTargets = useMemo(
    () =>
      [...new Set(sourceDocuments.flatMap((document) => document.topicIds || []))].slice(0, 28).map((topicId) => {
        const document = sourceDocuments.find((row) => row.topicIds?.includes(topicId));
        const level = document?.level || 'unknown';
        return {
          kind: 'module',
          domain: 'cfa',
          level,
          topicId,
          title: topicId.replace(/-/g, ' '),
          keywords: [topicId],
          route: level.startsWith('level') ? `/cfa/${level}/${topicId}` : '/cfa',
        };
      }),
    [sourceDocuments],
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
    if (pendingDelete.kind === 'source-document') await deleteCfaSourceDocument(pendingDelete.row.id);
    setPendingDelete(null);
    setMessage('Vault item removed.');
    refresh();
  }

  async function handleSourceBundleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSourceBusy(true);
    try {
      const { payload, parsedInWorker } = await parseJsonFile(file);
      const result = await importCfaSourceBundle(payload);
      setMessage(`Imported ${result.documents} private source document(s) and ${result.chunks} searchable chunk(s).${parsedInWorker ? ' Large bundle parsed off the main thread.' : ''}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to import source bundle.');
    } finally {
      setSourceBusy(false);
      event.target.value = '';
    }
  }

  async function handleDeleteAllSources() {
    setSourceBusy(true);
    await deleteAllCfaSourceVault();
    setSourceBusy(false);
    setMessage('Private CFA Source Vault cleared.');
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
        <Dialog
          title="Remove Local Vault Item"
          description={`Remove "${pendingDelete.row.title}" from this browser profile? This affects only local data.`}
          onClose={() => setPendingDelete(null)}
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmDelete}>Remove</button>
            </>
          }
        />
      )}

      <div className="grid-4 page-metrics">
        <MetricCard label="Notes" value={notes.length} detail="Saved locally" icon={StickyNote} />
        <MetricCard label="Bookmarks" value={bookmarks.length} detail="Marked lessons and questions" icon={Bookmark} tone="warning" />
        <MetricCard label="Artifacts" value={artifacts.length} detail="Calculator and lab outputs" icon={Database} tone="accent" />
        <MetricCard label="Sources" value={sourceDocuments.length} detail={`${sourceCoverage?.chunkCount || 0} private chunks`} icon={BookText} tone="success" />
      </div>

      <Surface density="compact" className="filter-panel">
        <label className="vault-search">
          <Search size={16} />
          <input
            aria-label="Search local vault"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, bookmarks, formulas, questions, artifacts..."
          />
        </label>
      </Surface>

      <SegmentedControl label="Vault filter" options={filters} value={filter} onChange={setFilter} />
      {message && <p className="muted-copy">{message}</p>}

      <Panel tone="vault" title="CFA Source Vault" className="vault-wide-panel">
        <div className="action-row" style={{ marginBottom: 'var(--space-4)' }}>
          <label className="btn btn-primary">
            <FileUp size={16} /> Import .qvsource
            <input type="file" accept=".qvsource,application/json" onChange={handleSourceBundleImport} style={{ display: 'none' }} />
          </label>
          <button className="btn btn-secondary" onClick={handleDeleteAllSources} disabled={sourceBusy || sourceDocuments.length === 0}>
            <Trash2 size={16} /> Clear Sources
          </button>
          <StatusBadge tone="success"><ShieldCheck size={14} /> private local only</StatusBadge>
        </div>
        <div className="action-row source-map-actions">
          <SourceLinkManager
            targets={sourceMapTargets}
            onRebuilt={(result) => {
              setMessage(`Source map rebuilt for ${result.targets} target(s) with ${result.links} link(s).`);
              refresh();
            }}
          />
          <SourceMapStatus />
        </div>
        <label className="vault-search">
          <Search size={16} />
          <input
            aria-label="Search private CFA source vault"
            value={sourceQuery}
            onChange={(event) => setSourceQuery(event.target.value)}
            placeholder="Search imported CFA source text..."
          />
        </label>
        <div className="coverage-grid" style={{ marginTop: 'var(--space-4)' }}>
          <div>
            <strong>{sourceCoverage?.documentCount || 0} documents</strong>
            <small>{sourceCoverage?.chunkCount || 0} chunks · {sourceMapStatus?.linkCount || 0} native source links · standard vault exports omit source text</small>
          </div>
          <div>
            <strong>{sourceCoverage?.levelCounts?.level1 || 0} Level I · {sourceCoverage?.levelCounts?.level2 || 0} Level II · {sourceCoverage?.levelCounts?.level3 || 0} Level III</strong>
            <small>Coverage is built from imported private bundles on this device.</small>
          </div>
        </div>
        {sourceResults.length > 0 && (
          <div className="vault-list" style={{ marginTop: 'var(--space-4)' }}>
            {sourceResults.map((result) => (
              <div key={result.chunk.id} className={`vault-row ${focusedChunk === result.chunk.id ? 'source-focused-row' : ''}`}>
                <div>
                  <StatusBadge tone="vault">{result.document.level}</StatusBadge>
                  <h4>{result.document.title}</h4>
                  <p>{result.preview}</p>
                  <small className="muted-copy">{result.chunk.locator} · {result.document.publisher}</small>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="vault-list" style={{ marginTop: 'var(--space-4)' }}>
          {sourceDocuments.slice(0, 8).map((document) => (
            <div key={document.id} className="vault-row">
              <div>
                <StatusBadge tone="exam">{document.level}</StatusBadge>
                <h4>{document.title}</h4>
                <p>{document.publisher} · {document.year || 'n/a'} · {document.chunkCount} chunks · {document.canonical ? 'canonical' : 'duplicate/reference'}</p>
              </div>
              <button className="btn-icon btn-ghost" title="Delete source document" onClick={() => setPendingDelete({ kind: 'source-document', row: document })}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!sourceDocuments.length && <p className="muted-copy">Import a `.qvsource` bundle created by `npm run cfa:source:ingest` to search local CFA materials privately.</p>}
        </div>
      </Panel>

      <div className="grid-2 vault-section-grid">
        <Panel tone="vault" title="Notes">
          <div className="vault-list">
            {filteredNotes.length ? (
              filteredNotes.map((note) => (
                <div key={note.id} className="vault-row">
                  <div style={{ flex: 1 }}>
                    <StatusBadge tone="vault">{note.type}</StatusBadge>
                    <h4>{note.title}</h4>
                    {editingNote?.id === note.id ? (
                      <div>
                        <textarea
                          aria-label={`Edit ${note.title}`}
                          value={editBody}
                          onChange={(event) => setEditBody(event.target.value)}
                          style={{ width: '100%', minHeight: 120, resize: 'vertical' }}
                        />
                        <InlineCluster className="vault-editor-actions">
                          <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingNote(null)}>Cancel</button>
                        </InlineCluster>
                      </div>
                    ) : (
                      <p>{note.body}</p>
                    )}
                    {note.path && <Link to={note.path}>Open source</Link>}
                  </div>
                  <InlineCluster>
                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(note)}>Edit</button>
                    <button className="btn-icon btn-ghost" title="Delete note" onClick={() => setPendingDelete({ kind: 'note', row: note })}>
                      <Trash2 size={16} />
                    </button>
                  </InlineCluster>
                </div>
              ))
            ) : (
              <p className="muted-copy">No notes match this vault slice.</p>
            )}
          </div>
        </Panel>

        <Panel tone="vault" title="Bookmarks">
          <div className="vault-list">
            {filteredBookmarks.length ? (
              filteredBookmarks.map((bookmark) => (
                <div key={bookmark.id} className="vault-row">
                  <div>
                    <StatusBadge tone="quant">{bookmark.type}</StatusBadge>
                    <h4>{bookmark.title}</h4>
                    <Link to={bookmark.path}>Open source</Link>
                  </div>
                  <button className="btn-icon btn-ghost" title="Remove bookmark" onClick={() => setPendingDelete({ kind: 'bookmark', row: bookmark })}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p className="muted-copy">No bookmarks match this vault slice.</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel tone="vault" title="Result Artifacts" className="vault-wide-panel">
        <div className="vault-list">
          {filteredArtifacts.length ? (
            filteredArtifacts.map((artifact) => (
              <div key={artifact.id} className="vault-row">
                <div>
                  <StatusBadge tone="exam">{artifact.type}</StatusBadge>
                  <h4>{artifact.title}</h4>
                  <p>{artifact.summary}</p>
                  {artifact.path && <Link to={artifact.path}>Open tool</Link>}
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => createArtifactNote(artifact)}>Send to Notes</button>
              </div>
            ))
          ) : (
            <p className="muted-copy">No artifacts match this vault slice.</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
