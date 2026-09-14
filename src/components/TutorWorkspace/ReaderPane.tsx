import { AlertTriangle, BookOpenText, ChevronRight, FileQuestion } from 'lucide-react';
import type { TutorReaderContent, TutorSource } from './types';

interface ReaderPaneProps {
  source: TutorSource | null;
  content: TutorReaderContent;
  activeLocator?: string;
}

export function ReaderPane({ source, content, activeLocator }: ReaderPaneProps) {
  return (
    <section className="tutor-reader" aria-labelledby="tutor-reader-title">
      <header className="tutor-reader-head">
        <div>
          <span className="tutor-kicker">Reader</span>
          <h2 id="tutor-reader-title">{source?.title || 'Choose a source'}</h2>
          {source && <p>{source.subtitle}</p>}
        </div>
        {source && <span className={`tutor-provenance tutor-provenance-${source.provenance}`}>{source.provenance}</span>}
      </header>

      {!source && (
        <div className="tutor-empty-reader">
          <BookOpenText size={28} aria-hidden="true" />
          <h3>Put the source beside the tutor</h3>
          <p>Select curriculum, an imported notebook source, or a saved tutor response.</p>
        </div>
      )}
      {source && source.coverage === 'missing' && (
        <div className="tutor-coverage-warning" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Coverage is missing.</strong><p>This document has no searchable text. Run OCR or import a text-readable copy before relying on grounded answers.</p></div>
        </div>
      )}
      {source && content.state === 'loading' && <div className="tutor-reader-loading" role="status">Preparing the source…</div>}
      {source && content.state === 'error' && <p className="tutor-inline-error" role="alert">{content.error}</p>}
      {source?.kind === 'notebook-source' && content.state !== 'error' && (
        <div className="tutor-empty-reader tutor-empty-reader-subtle">
          <FileQuestion size={24} aria-hidden="true" />
          <h3>Embedded source</h3>
          <p>The full text stays in the local notebook sidecar. Ask a question to retrieve only the supporting passages.</p>
        </div>
      )}
      {source?.kind === 'generated-note' && (
        <article className="tutor-reading-copy tutor-generated-copy"><p>{source.generatedBody}</p></article>
      )}
      {source?.kind === 'cfa-document' && content.state === 'empty' && source.coverage !== 'missing' && (
        <div className="tutor-empty-reader tutor-empty-reader-subtle"><p>No readable sections were found for this document.</p></div>
      )}
      {source?.kind === 'cfa-document' && content.state === 'ready' && (
        <div className="tutor-reading-copy">
          {content.chunks.map((chunk) => (
            <article key={chunk.id} data-active={Boolean(activeLocator && chunk.locator === activeLocator)}>
              <div className="tutor-reading-locator"><ChevronRight size={13} aria-hidden="true" /> {chunk.locator}</div>
              {chunk.heading && <h3>{chunk.heading}</h3>}
              <p>{chunk.text}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
