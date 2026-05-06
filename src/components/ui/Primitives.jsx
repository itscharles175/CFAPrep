import { createElement, isValidElement } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

function joinClasses(...parts) {
  return parts.filter(Boolean).join(' ');
}

function iconNode(icon, size = 18) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return createElement(icon, { size, 'aria-hidden': true });
}

export function Surface({
  as: Component = 'div',
  tone = 'default',
  density = 'default',
  status,
  interactive = false,
  className,
  children,
  ...props
}) {
  return (
    <Component
      className={joinClasses(
        'surface',
        `surface-${tone}`,
        `surface-${density}`,
        status && `surface-status-${status}`,
        interactive && 'surface-interactive',
        className,
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

export function StatusBadge({ children, tone = 'accent', icon, className, ...props }) {
  return (
    <span className={joinClasses('status-badge', `status-badge-${tone}`, className)} {...props}>
      {iconNode(icon, 12)}
      {children}
    </span>
  );
}

export function ActionBar({ children, align = 'end', className }) {
  return <div className={joinClasses('action-bar', `action-bar-${align}`, className)}>{children}</div>;
}

export function PageHeader({ badge, title, subtitle, actions, tone = 'study', eyebrow, meta }) {
  return (
    <header className={joinClasses('page-header', `page-header-${tone}`)}>
      <div className="page-header-copy">
        {(badge || eyebrow) && (
          <StatusBadge tone={tone === 'ops' ? 'ops' : tone === 'vault' ? 'vault' : tone === 'exam' ? 'exam' : 'accent'}>
            {badge || eyebrow}
          </StatusBadge>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {meta && <div className="page-header-meta">{meta}</div>}
      </div>
      {actions && <ActionBar>{actions}</ActionBar>}
    </header>
  );
}

export function MetricTile({ label, value, detail, icon, tone = 'accent', status, className }) {
  return (
    <Surface tone="metric" density="compact" status={status || tone} className={joinClasses('metric-tile', className)}>
      <div className={joinClasses('metric-tile-icon', `metric-tile-icon-${tone}`)}>{iconNode(icon)}</div>
      <div className="metric-tile-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </Surface>
  );
}

export function MetricCard(props) {
  return <MetricTile {...props} />;
}

export function CommandHint({ keys, label }) {
  const renderedKeys = Array.isArray(keys) ? keys : [keys];
  return (
    <span className="command-hint">
      {renderedKeys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
      {label && <span>{label}</span>}
    </span>
  );
}

export function ProgressRail({ value = 0, max = 100, label, detail, tone = 'accent' }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="progress-rail" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} role="progressbar">
      {(label || detail) && (
        <div className="progress-rail-label">
          <span>{label}</span>
          <small>{detail || `${pct}%`}</small>
        </div>
      )}
      <div className="progress-rail-track">
        <div className={`progress-rail-fill progress-rail-fill-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SegmentedControl({ label, options, value, onChange, density = 'default' }) {
  function moveFocus(event, index) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const lastIndex = options.length - 1;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = lastIndex;
    const next = options[nextIndex];
    onChange(next.value);
    event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')?.[nextIndex]?.focus();
  }

  return (
    <div className={joinClasses('segmented-row', `segmented-row-${density}`)} role="tablist" aria-label={label}>
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={joinClasses('segmented-tab', selected && 'active')}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {iconNode(option.icon, 16)}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function DataTable({ columns = [], rows = [], empty = 'No rows available.', className }) {
  return (
    <div className={joinClasses('data-panel', className)} role="table">
      {columns.length > 0 && (
        <div className="data-panel-row data-panel-head" role="row">
          {columns.map((column) => (
            <span key={column} role="columnheader">{column}</span>
          ))}
        </div>
      )}
      {rows.length ? (
        rows.map((row) => (
          <div key={row.id} className={joinClasses('data-panel-row', row.tone && `data-panel-row-${row.tone}`)} role="row">
            {row.cells.map((cell, index) => (
              <span key={`${row.id}:${index}`} role="cell">{cell}</span>
            ))}
          </div>
        ))
      ) : (
        <div className="data-panel-empty">{empty}</div>
      )}
    </div>
  );
}

export function QuestionStage({ badge, question, objective, children, footer, status = 'active' }) {
  return (
    <Surface tone="study" status={status} className="question-stage">
      <div className="question-stage-head">
        {badge && <StatusBadge tone="exam">{badge}</StatusBadge>}
        {objective && <StatusBadge tone="vault">{objective}</StatusBadge>}
      </div>
      <div className="question-stage-prompt">{question}</div>
      {children}
      {footer && <div className="question-stage-footer">{footer}</div>}
    </Surface>
  );
}

export function CaseViewer({ title = 'Case Facts', children, exhibits = [] }) {
  return (
    <Surface tone="case" className="case-viewer">
      <div className="case-viewer-copy">
        <StatusBadge tone="exam">{title}</StatusBadge>
        <div>{children}</div>
      </div>
      {exhibits.length > 0 && (
        <div className="case-exhibits">
          {exhibits.map((exhibit) => (
            <div key={exhibit.id} className="case-exhibit">
              <strong>{exhibit.title}</strong>
              <small>{exhibit.content}</small>
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}

export function RubricPanel({ criteria = [], scores = {}, onScore, maxPoints, title = 'Rubric' }) {
  return (
    <Surface tone="ops" className="rubric-panel">
      <div className="rubric-panel-head">
        <h2>{title}</h2>
        {maxPoints !== undefined && <StatusBadge tone="warning">{maxPoints} pts</StatusBadge>}
      </div>
      <div className="rubric-criteria">
        {criteria.map((criterion) => (
          <label key={criterion.id} className="rubric-row">
            <span>
              <strong>{criterion.label}</strong>
              <small>{criterion.description}</small>
            </span>
            <input
              type="number"
              min="0"
              max={criterion.points}
              value={scores[criterion.id] ?? 0}
              onChange={(event) => onScore?.(criterion.id, Number(event.target.value))}
            />
            <em>/ {criterion.points}</em>
          </label>
        ))}
      </div>
    </Surface>
  );
}

export function ReviewItemCard({ item }) {
  return (
    <Surface as={Link} to={item.path} tone="vault" interactive className="review-item-card">
      <div>
        <StatusBadge tone="vault">{item.type.replace('-', ' ')}</StatusBadge>
        <h3>{item.title}</h3>
        <p>{item.subtitle}</p>
        {item.reason && (
          <small className="command-hint">
            Reason: {item.reason.replace(/-/g, ' ')}
            {typeof item.retentionPct === 'number' ? ` · retention ${item.retentionPct}%` : ''}
          </small>
        )}
      </div>
      <ChevronRight size={18} color="var(--text-muted)" aria-hidden="true" />
    </Surface>
  );
}
