import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// UB7 — accessible tab strip for the sticky study-session card.
//
// Implements the WAI-ARIA Tabs pattern: a role="tablist" of role="tab" buttons
// driving sibling role="tabpanel" regions. Keyboard model matches the host's
// SegmentedControl (roving tabindex + Arrow/Home/End), but uses tab semantics
// (the panel is owned by Today, rendered separately so it can stay sticky).
//
// Tabs are *manual-activation*: arrow keys move focus between tabs and the panel
// follows immediately (single-panel apps where switching is cheap), which keeps
// the interaction predictable for keyboard users without an extra Enter press.
// ---------------------------------------------------------------------------

export interface SessionTab {
  id: string;
  label: ReactNode;
  /** Optional leading glyph/icon node rendered before the label. */
  icon?: ReactNode;
  /** Optional trailing badge (e.g. a live timer readout). */
  trailing?: ReactNode;
}

export interface SessionTabsProps {
  tabs: SessionTab[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist. */
  label: string;
  /**
   * Stable id prefix so tab/panel `id`/`aria-controls` wiring is deterministic.
   * Defaults to a generated id; pass one when the panel lives in another
   * component (as it does in the study-session card).
   */
  idBase?: string;
  className?: string;
}

/** Deterministic dom id for a tab button. */
export function sessionTabId(idBase: string, tabId: string): string {
  return `${idBase}-tab-${tabId}`;
}

/** Deterministic dom id for a tab panel. */
export function sessionPanelId(idBase: string, tabId: string): string {
  return `${idBase}-panel-${tabId}`;
}

export function SessionTabs({ tabs, activeId, onChange, label, idBase, className }: SessionTabsProps) {
  const generatedId = useId();
  const base = idBase || generatedId;
  const listRef = useRef<HTMLDivElement | null>(null);

  function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = tabs.length - 1;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = last;
    const target = tabs[next];
    onChange(target.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')?.[next]?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={['session-tablist', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        gap: 'var(--space-1)',
        alignItems: 'stretch',
        flexWrap: 'wrap',
      }}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={sessionTabId(base, tab.id)}
            aria-selected={selected}
            aria-controls={sessionPanelId(base, tab.id)}
            tabIndex={selected ? 0 : -1}
            className={`session-tab${selected ? ' active' : ''}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => moveFocus(event, index)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md, 8px)',
              border: '1px solid var(--border)',
              background: selected ? 'var(--accent-soft, rgba(96,165,250,0.18))' : 'transparent',
              color: selected ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: selected ? 'var(--fw-semibold, 600)' : 'var(--fw-medium, 500)',
              cursor: 'pointer',
              transition:
                'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
            }}
          >
            {tab.icon && (
              <span aria-hidden="true" style={{ display: 'inline-flex' }}>
                {tab.icon}
              </span>
            )}
            <span>{tab.label}</span>
            {tab.trailing != null && <span className="session-tab-trailing">{tab.trailing}</span>}
          </button>
        );
      })}
    </div>
  );
}
