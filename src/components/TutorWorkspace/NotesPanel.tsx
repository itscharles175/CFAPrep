import { Check, Highlighter, RotateCcw, Save, StickyNote } from 'lucide-react';
import { useRef } from 'react';

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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: Array<{ id: NoteKind; label: string; icon: typeof StickyNote }> = [
    { id: 'notes', label: 'Notes', icon: StickyNote },
    { id: 'annotations', label: 'Annotations', icon: Highlighter },
  ];

  return (
    <section className="tutor-notes" aria-label="Notes and annotations">
      <div className="tutor-notes-tabs" role="tablist" aria-label="Source writing mode">
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={`tutor-writing-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              aria-controls="tutor-writing-panel"
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => onActiveChange(tab.id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                onActiveChange(tabs[nextIndex].id);
                tabRefs.current[nextIndex]?.focus();
              }}
            >
              <Icon size={14} aria-hidden="true" /> {tab.label}
            </button>
          );
        })}
      </div>
      <div id="tutor-writing-panel" role="tabpanel" aria-labelledby={`tutor-writing-${active}-tab`}>
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
      </div>
    </section>
  );
}
