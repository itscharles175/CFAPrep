/**
 * Shared visual primitives for the embedded open-notebook surfaces.
 *
 * Goal of this module: keep the open-notebook UX feeling native to
 * QuantVault.  Citation chips, source legends, and insight tiles all
 * render through these tokens so we ship one visual language across
 * the curriculum-read / Ask-the-curriculum / Key-Insights flows.
 *
 * Every component here is style-token only — no inline `style={{}}`
 * blocks, no hard-coded colours.  Adopters need only import them.
 */

import type { ReactNode } from 'react';

export interface CitationChipProps {
  /** The 1-based citation number rendered inside the chip. */
  number: number;
  /** Source title for the tooltip + accessibility. */
  title?: string;
  /** Optional extra margin-left between adjacent chips. Default: none. */
  spaced?: boolean;
}

/**
 * Numbered superscript-style citation chip — replaces the inline-styled
 * `<span>` previously copy-pasted across CfaModule.  Uses `qv-chip` so the
 * styling tracks the design-token layer.
 */
export function CitationChip({ number, title, spaced = false }: CitationChipProps) {
  return (
    <span
      className={`qv-chip ${spaced ? 'qv-ml-1' : ''}`}
      data-citation={number}
      title={title || `Citation ${number}`}
      aria-label={title ? `Citation ${number}: ${title}` : `Citation ${number}`}
    >
      {number}
    </span>
  );
}

export interface SourceLegendEntry {
  /** Stable source id from the embedded notebook. */
  id: string;
  /** Human-friendly title; falls back to "Curriculum source". */
  title?: string;
}

export interface SourceLegendProps {
  entries: SourceLegendEntry[];
}

/**
 * Numbered legend for the citation chips above the body text.
 * Each row: `<n>. <Source title>  <id>`.
 */
export function SourceLegend({ entries }: SourceLegendProps) {
  if (!entries.length) return null;
  return (
    <ol className="qv-stack-1 qv-mt-3 qv-fs-sm qv-text-muted" style={{ paddingLeft: 'var(--space-5)' }}>
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <strong className="qv-text-secondary">{entry.title || 'Curriculum source'}</strong>
          <span className="qv-mono qv-fs-xs qv-ml-2">{entry.id}</span>
          <CitationChip number={index + 1} title={entry.title} spaced />
        </li>
      ))}
    </ol>
  );
}

export interface InsightCardProps {
  title?: ReactNode;
  /** Free-form body content. */
  children: ReactNode;
  /** Optional locator chip (e.g. page number / LOS). */
  locator?: string;
  /** Optional accent — defaults to the topic accent currently active. */
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

/**
 * One open-notebook "Key Insight" rendered as a callout card.  Standard
 * design-token padding, accent left border, monospace locator chip on
 * the right.
 */
export function InsightCard({ title, children, locator, tone = 'default' }: InsightCardProps) {
  const toneClass =
    tone === 'success'
      ? 'qv-text-success'
      : tone === 'warning'
        ? 'qv-text-warning'
        : tone === 'danger'
          ? 'qv-text-danger'
          : '';
  return (
    <div className="qv-callout qv-stack-2">
      {(title || locator) && (
        <div className="qv-row-between">
          {title ? <strong className={`qv-fs-sm qv-fw-semibold ${toneClass}`.trim()}>{title}</strong> : <span />}
          {locator && <span className="qv-chip qv-mono">{locator}</span>}
        </div>
      )}
      <div className="qv-fs-sm">{children}</div>
    </div>
  );
}
