import { BookOpen, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { TutorCitation } from './types';

export function CitationPanel({ citation, onClose }: { citation: TutorCitation | null; onClose: () => void }) {
  useEffect(() => {
    if (!citation) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [citation, onClose]);

  if (!citation) return null;
  return (
    <aside className="tutor-citation-panel" aria-label={`Citation ${citation.number}`}>
      <header>
        <span><BookOpen size={15} aria-hidden="true" /> Supporting source</span>
        <button type="button" onClick={onClose} aria-label="Close citation panel"><X size={16} /></button>
      </header>
      <div>
        <span className={`tutor-provenance tutor-provenance-${citation.provenance}`}><ShieldCheck size={12} /> {citation.provenance}</span>
        <h3>{citation.title}</h3>
        {citation.locator && <p className="tutor-citation-locator">{citation.locator}</p>}
        {citation.snippet ? <blockquote>{citation.snippet}</blockquote> : <p className="tutor-muted">The provider identified this source but did not return an excerpt.</p>}
        {citation.sourceId && (
          <Link to={`/vault?sourceQuery=${encodeURIComponent(citation.title)}&chunk=${encodeURIComponent(citation.sourceId)}`}>
            Open in Library <ExternalLink size={13} />
          </Link>
        )}
      </div>
    </aside>
  );
}
