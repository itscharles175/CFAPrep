import { useState, type ReactNode } from 'react';
import { SessionTabs, sessionPanelId, sessionTabId, type SessionTab } from './SessionTabs';

// ---------------------------------------------------------------------------
// UB7 — sticky, tabbed "study session" card.
//
// Consolidates Today's three session affordances — focus Timer, the day's Plan
// summary, and the daily Journal — into ONE card that stays pinned below the
// page header while the rest of Today scrolls. This is a presentational shell:
// all timer/journal/plan logic stays in Today.tsx and is passed in as panel
// content, so nothing is rewritten — only consolidated behind an accessible tab
// strip.
//
// Accessibility: SessionTabs renders the role="tablist"; here we render exactly
// one role="tabpanel" for the active tab (matching aria-controls / aria-labelledby
// wiring). Reduced motion is handled globally (index.css damps all transitions),
// so the sticky card and tab transitions degrade gracefully.
// ---------------------------------------------------------------------------

export interface StudySessionPanel extends SessionTab {
  /** The panel body shown when this tab is active. */
  content: ReactNode;
}

export interface StudySessionCardProps {
  panels: StudySessionPanel[];
  /** Initially-active tab id. Defaults to the first panel. */
  defaultTabId?: string;
  /** Stable id prefix for deterministic tab/panel wiring. */
  idBase?: string;
  /**
   * Distance from the top of the scroll viewport the card sticks at. Defaults
   * to clearing the fixed top bar plus a small gutter. Pass a CSS length.
   */
  stickyTop?: string;
  className?: string;
}

export function StudySessionCard({
  panels,
  defaultTabId,
  idBase = 'study-session',
  stickyTop = 'calc(var(--topbar-height, 64px) + var(--space-3))',
  className,
}: StudySessionCardProps) {
  const firstId = panels[0]?.id;
  const [activeId, setActiveId] = useState<string>(defaultTabId || firstId || '');

  // Guard against an activeId that no longer exists (panels can change shape as
  // the plan loads). Fall back to the first available panel.
  const active = panels.find((panel) => panel.id === activeId) || panels[0];
  if (!active) return null;

  const tabs: SessionTab[] = panels.map(({ content: _content, ...tab }) => tab);

  return (
    <section
      aria-label="Study session"
      className={['study-session-card surface surface-study', className].filter(Boolean).join(' ')}
      style={{
        position: 'sticky',
        top: stickyTop,
        zIndex: 5,
        marginBottom: 'var(--space-6)',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-lg, 12px)',
        boxShadow: 'var(--elevation-2)',
        // A slightly more opaque backdrop so content scrolling *under* the
        // sticky card stays legible behind it. audit (LOW) — pair the -webkit-
        // prefix so the saturate applies in the Electron renderer too (every
        // other backdrop-filter site in the codebase pairs them).
        backdropFilter: 'saturate(140%)',
        WebkitBackdropFilter: 'saturate(140%)',
      }}
    >
      <SessionTabs tabs={tabs} activeId={active.id} onChange={setActiveId} label="Study session" idBase={idBase} />
      <div
        role="tabpanel"
        id={sessionPanelId(idBase, active.id)}
        aria-labelledby={sessionTabId(idBase, active.id)}
        tabIndex={0}
        className="study-session-panel qv-mt-3"
        style={{ outline: 'none' }}
      >
        {active.content}
      </div>
    </section>
  );
}
