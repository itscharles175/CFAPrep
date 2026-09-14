import { BookmarkCheck, CircleStop, MessageSquareText, RotateCcw, Save, Send, ShieldAlert } from 'lucide-react';
import type { TutorCitation, TutorSource, TutorTurn } from './types';

interface TutorPanelProps {
  source: TutorSource | null;
  question: string;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onSave: () => void;
  onCitationSelect: (citation: TutorCitation) => void;
  activeCitationId?: string;
  turn: TutorTurn | null;
  state: 'idle' | 'running' | 'success' | 'cancelled' | 'error' | 'saving' | 'saved' | 'save-error';
  error?: string;
}

function AnswerText({ turn, onCitationSelect }: { turn: TutorTurn; onCitationSelect: (citation: TutorCitation) => void }) {
  const byNumber = new Map(turn.citations.map((citation) => [citation.number, citation]));
  return (
    <p>
      {turn.answer.split(/(\[\d+\])/g).filter(Boolean).map((part, index) => {
        const match = part.match(/^\[(\d+)\]$/);
        const citation = match ? byNumber.get(Number(match[1])) : undefined;
        return citation ? (
          <button key={`${part}-${index}`} type="button" className="tutor-citation-chip" onClick={() => onCitationSelect(citation)} aria-label={`Open citation ${citation.number}: ${citation.title}`}>
            {citation.number}
          </button>
        ) : <span key={`${part}-${index}`}>{part}</span>;
      })}
    </p>
  );
}

export function TutorPanel({ source, question, onQuestionChange, onAsk, onCancel, onRetry, onSave, onCitationSelect, activeCitationId, turn, state, error }: TutorPanelProps) {
  const canAsk = Boolean(source && question.trim() && source.coverage !== 'missing' && source.kind !== 'generated-note');
  return (
    <aside className="tutor-conversation" aria-labelledby="tutor-conversation-title">
      <header className="tutor-pane-heading">
        <div><span className="tutor-kicker">Grounded dialogue</span><h2 id="tutor-conversation-title">Tutor</h2></div>
        <span className="tutor-local-pill">Local only</span>
      </header>

      <div className="tutor-thread" aria-live="polite">
        {state === 'idle' && (
          <div className="tutor-empty-compact"><MessageSquareText size={22} aria-hidden="true" /><p>Ask about the selected source. Every answer must show where it came from.</p></div>
        )}
        {state === 'running' && (
          <div className="tutor-thinking" role="status"><span /><span /><span /><p>Retrieving evidence and checking citations…</p></div>
        )}
        {(state === 'error' || state === 'save-error') && (
          <div className="tutor-response-error" role="alert">
            <ShieldAlert size={18} aria-hidden="true" />
            <div><strong>{state === 'save-error' ? 'The answer is safe, but it was not saved.' : 'The tutor could not answer.'}</strong><p>{error}</p></div>
          </div>
        )}
        {state === 'cancelled' && <div className="tutor-cancelled" role="status">Request cancelled. Your question is still here.</div>}
        {turn && !['running', 'error'].includes(state) && (
          <div className="tutor-turn">
            <div className="tutor-user-question">{turn.question}</div>
            <div className="tutor-answer"><AnswerText turn={turn} onCitationSelect={onCitationSelect} /></div>
            {turn.citations.length === 0 ? (
              <div className="tutor-missing-grounding"><ShieldAlert size={15} aria-hidden="true" /> No supporting citations were returned. Treat this response as unsupported.</div>
            ) : (
              <div className="tutor-citation-list" aria-label="Answer citations">
                {turn.citations.map((citation) => (
                  <button key={citation.id} type="button" data-active={citation.id === activeCitationId} onClick={() => onCitationSelect(citation)}>
                    <span>{citation.number}</span><strong>{citation.title}</strong><small>{citation.locator || citation.provenance}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="tutor-answer-actions">
              <span>{state === 'saved' && <><BookmarkCheck size={14} aria-hidden="true" /> Saved to Library</>}</span>
              {state === 'save-error' ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={onSave}><RotateCcw size={14} /> Retry save</button>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={onSave} disabled={state === 'saving' || state === 'saved'}><Save size={14} /> {state === 'saving' ? 'Saving…' : 'Save response'}</button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="tutor-composer">
        <label htmlFor="tutor-question">Ask from this source</label>
        <textarea id="tutor-question" value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder={source ? `Ask about ${source.title}` : 'Choose a source first'} disabled={!source} />
        <div>
          <span>{source?.coverage === 'missing' ? 'Searchable coverage required' : source?.kind === 'generated-note' ? 'Generated responses cannot ground a new answer' : source?.kind === 'notebook-source' ? 'Answer constrained to this embedded source' : 'Answer constrained to this topic and cited source library'}</span>
          {state === 'running' ? (
            <button type="button" className="btn btn-secondary" onClick={onCancel}><CircleStop size={15} /> Cancel</button>
          ) : state === 'error' || state === 'cancelled' ? (
            <button type="button" className="btn btn-primary" onClick={onRetry} disabled={!canAsk}><RotateCcw size={15} /> Retry</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onAsk} disabled={!canAsk}><Send size={15} /> Ask tutor</button>
          )}
        </div>
      </div>
    </aside>
  );
}
