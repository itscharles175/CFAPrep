import { Check, Highlighter, RotateCcw, Save, StickyNote } from 'lucide-react';

export type NoteKind = 'notes' | 'annotations';

interface NotesPanelProps {
  active: NoteKind;
  onActiveChange: (kind: NoteKind) => void;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
  state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  error?: string;
  disabled?: boolean;
}

export function NotesPanel({ active, onActiveChange, value, onChange, onSave, onRetry, state, error, disabled }: NotesPanelProps) {
  return (
    <section className="tutor-notes" aria-label="Notes and annotations">
      <div className="tutor-notes-tabs" role="tablist" aria-label="Source writing mode">
        <button type="button" role="tab" aria-selected={active === 'notes'} onClick={() => onActiveChange('notes')}>
          <StickyNote size={14} aria-hidden="true" /> Notes
        </button>
        <button type="button" role="tab" aria-selected={active === 'annotations'} onClick={() => onActiveChange('annotations')}>
          <Highlighter size={14} aria-hidden="true" /> Annotations
        </button>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={active === 'notes' ? 'Source notes' : 'Source annotations'}
        placeholder={disabled ? 'Select a source to begin writing.' : active === 'notes' ? 'Capture the idea in your own words…' : 'Record a locator, quote, or question…'}
      />
      <div className="tutor-notes-actions">
        <span role="status">
          {state === 'saving' && 'Saving…'}
          {state === 'saved' && <><Check size={13} aria-hidden="true" /> Saved locally</>}
          {state === 'error' && error}
        </span>
        {state === 'error' ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}><RotateCcw size={14} /> Retry</button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onSave} disabled={disabled || state === 'saving' || state === 'idle' || state === 'saved'}><Save size={14} /> Save</button>
        )}
      </div>
    </section>
  );
}
