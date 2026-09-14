import { BookMarked, FileInput, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TutorSource, TutorSourceProvenance } from './types';

const provenanceMeta: Record<TutorSourceProvenance, { label: string; icon: typeof BookMarked }> = {
  'built-in': { label: 'Built in', icon: BookMarked },
  imported: { label: 'Imported', icon: FileInput },
  generated: { label: 'Generated', icon: Sparkles },
};

interface SourceNavigatorProps {
  sources: TutorSource[];
  selectedId: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (source: TutorSource) => void;
  loading: boolean;
  error?: string;
}

export function SourceNavigator({ sources, selectedId, query, onQueryChange, onSelect, loading, error }: SourceNavigatorProps) {
  const groups = (Object.keys(provenanceMeta) as TutorSourceProvenance[])
    .map((provenance) => ({ provenance, sources: sources.filter((source) => source.provenance === provenance) }))
    .filter((group) => group.sources.length > 0);

  return (
    <aside className="tutor-source-nav" aria-label="Tutor sources">
      <div className="tutor-pane-heading">
        <div>
          <span className="tutor-kicker">Grounding set</span>
          <h2>Sources</h2>
        </div>
        <span className="tutor-count" aria-label={`${sources.length} sources`}>{sources.length}</span>
      </div>

      <label className="tutor-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Filter sources</span>
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Filter your library" />
      </label>

      {loading && <p className="tutor-muted" role="status">Loading your source library…</p>}
      {error && <p className="tutor-inline-error" role="alert">{error}</p>}
      {!loading && !error && sources.length === 0 && (
        <div className="tutor-empty-compact">
          <BookMarked size={20} aria-hidden="true" />
          <p>{query ? 'No sources match this filter.' : 'No sources yet.'}</p>
          {query ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onQueryChange('')}>Clear filter</button>
          ) : null}
        </div>
      )}

      <div className="tutor-source-groups">
        {groups.map(({ provenance, sources: rows }) => {
          const meta = provenanceMeta[provenance];
          const Icon = meta.icon;
          return (
            <section key={provenance} aria-labelledby={`tutor-source-${provenance}`}>
              <h3 id={`tutor-source-${provenance}`}><Icon size={13} aria-hidden="true" /> {meta.label}</h3>
              <div className="tutor-source-list">
                {rows.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className="tutor-source-row"
                    data-selected={source.id === selectedId}
                    onClick={() => onSelect(source)}
                    aria-pressed={source.id === selectedId}
                  >
                    <span>
                      <strong>{source.title}</strong>
                      <small>{source.subtitle}</small>
                    </span>
                    <span className={`tutor-coverage tutor-coverage-${source.coverage}`}>{source.coverage}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <Link className="tutor-manage-library" to="/vault">Manage Library</Link>
    </aside>
  );
}
