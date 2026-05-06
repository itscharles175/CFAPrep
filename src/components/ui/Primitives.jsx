import { createElement, isValidElement, useEffect, useId, useRef } from 'react';
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

export function InlineCluster({ children, align = 'start', className }) {
  return <div className={joinClasses('inline-cluster', `inline-cluster-${align}`, className)}>{children}</div>;
}

export function IconFrame({ icon, tone = 'accent', size = 18, className, children }) {
  return (
    <span className={joinClasses('icon-frame', `icon-frame-${tone}`, className)} aria-hidden={!children}>
      {children || iconNode(icon, size)}
    </span>
  );
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

export function PageSection({ eyebrow, title, subtitle, actions, children, tone = 'default', className }) {
  return (
    <section className={joinClasses('page-section', `page-section-${tone}`, className)}>
      {(eyebrow || title || subtitle || actions) && (
        <div className="page-section-head">
          <div className="page-section-copy">
            {eyebrow && <StatusBadge tone={tone === 'default' ? 'accent' : tone}>{eyebrow}</StatusBadge>}
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <ActionBar>{actions}</ActionBar>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({
  as: Component = 'div',
  title,
  eyebrow,
  subtitle,
  icon,
  actions,
  footer,
  children,
  tone = 'default',
  density = 'default',
  status,
  interactive = false,
  className,
  ...props
}) {
  return (
    <Surface
      as={Component}
      tone={tone}
      density={density}
      status={status}
      interactive={interactive}
      className={joinClasses('panel', className)}
      {...props}
    >
      {(title || eyebrow || subtitle || icon || actions) && (
        <div className="panel-head">
          <div className="panel-title-row">
            {icon && <IconFrame icon={icon} tone={status || tone} size={18} />}
            <div className="panel-title-copy">
              {eyebrow && <StatusBadge tone={status || tone}>{eyebrow}</StatusBadge>}
              {title && <h3>{title}</h3>}
              {subtitle && <p>{subtitle}</p>}
            </div>
          </div>
          {actions && <ActionBar>{actions}</ActionBar>}
        </div>
      )}
      {children && <div className="panel-body">{children}</div>}
      {footer && <div className="panel-footer">{footer}</div>}
    </Surface>
  );
}

export function StatGrid({ children, columns = 3, className }) {
  return <div className={joinClasses('stat-grid', `stat-grid-${columns}`, className)}>{children}</div>;
}

export function StatCell({ label, value, tone = 'accent', detail, className }) {
  return (
    <div className={joinClasses('stat-cell', `stat-cell-${tone}`, className)}>
      <small>{label}</small>
      <strong>{value}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

export function EmptyPanel({ title, description, action, tone = 'default', className }) {
  return (
    <Surface tone={tone} className={joinClasses('empty-panel', className)}>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="empty-panel-action">{action}</div>}
    </Surface>
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
    event.currentTarget.parentElement?.querySelectorAll('[role="radio"]')?.[nextIndex]?.focus();
  }

  return (
    <div className={joinClasses('segmented-row', `segmented-row-${density}`)} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
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

export function Dialog({ title, description, children, actions, onClose, labelledBy, className }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    const firstFocusable = dialogRef.current?.querySelector(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable || dialogRef.current)?.focus?.();
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="confirm-dialog" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div
        ref={dialogRef}
        className={joinClasses('surface surface-default confirm-dialog-card', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        {title && <h2 id={titleId}>{title}</h2>}
        {description && <p id={descriptionId}>{description}</p>}
        {children}
        {actions && <InlineCluster align="end">{actions}</InlineCluster>}
      </div>
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
        {item.reasonDetails?.length > 0 && (
          <small className="muted-copy">{item.reasonDetails.slice(0, 2).join(' ')}</small>
        )}
        {item.weaknessSignals?.length > 0 && (
          <small className="command-hint">
            Signals: {item.weaknessSignals.slice(0, 2).map((signal) => `${signal.label} (${signal.impact})`).join(' · ')}
          </small>
        )}
      </div>
      <ChevronRight size={18} color="var(--text-muted)" aria-hidden="true" />
    </Surface>
  );
}
