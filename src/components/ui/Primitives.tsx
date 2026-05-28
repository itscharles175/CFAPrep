import {
  createElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ComponentType,
  type ElementType,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

// An icon can be a React element already (`<Icon size={12} />`) or a
// component reference to render (`Icon`). Lucide icons are forwardRef
// objects, which TypeScript treats as `ComponentType`-compatible.
type IconLike =
  | ReactElement
  | ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function iconNode(icon: IconLike | undefined, size = 18): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  // Anything else is treated as a component type (function, class, or
  // forwardRef/memo object — including `lucide-react` icons).
  return createElement(icon as ComponentType<{ size?: number; 'aria-hidden'?: boolean }>, {
    size,
    'aria-hidden': true,
  });
}

type Tone = string;
type Density = string;
type Status = string;

interface SurfaceProps {
  as?: ElementType;
  tone?: Tone;
  density?: Density;
  status?: Status;
  interactive?: boolean;
  className?: string;
  children?: ReactNode;
  // Polymorphic surface — accept any extra props (router `to`, `onClick`,
  // ARIA, data-*, etc.) and forward them to the underlying element.
  [key: string]: unknown;
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
}: SurfaceProps) {
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

interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
  tone?: Tone;
  icon?: IconLike;
  className?: string;
}

export function StatusBadge({ children, tone = 'accent', icon, className, ...props }: StatusBadgeProps) {
  return (
    <span className={joinClasses('status-badge', `status-badge-${tone}`, className)} {...props}>
      {iconNode(icon, 12)}
      {children}
    </span>
  );
}

interface ActionBarProps {
  children?: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export function ActionBar({ children, align = 'end', className }: ActionBarProps) {
  return <div className={joinClasses('action-bar', `action-bar-${align}`, className)}>{children}</div>;
}

interface InlineClusterProps {
  children?: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export function InlineCluster({ children, align = 'start', className }: InlineClusterProps) {
  return <div className={joinClasses('inline-cluster', `inline-cluster-${align}`, className)}>{children}</div>;
}

interface IconFrameProps {
  icon?: IconLike;
  tone?: Tone;
  size?: number;
  className?: string;
  children?: ReactNode;
}

export function IconFrame({ icon, tone = 'accent', size = 18, className, children }: IconFrameProps) {
  return (
    <span className={joinClasses('icon-frame', `icon-frame-${tone}`, className)} aria-hidden={!children}>
      {children || iconNode(icon, size)}
    </span>
  );
}

interface PageHeaderProps {
  badge?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tone?: Tone;
  eyebrow?: ReactNode;
  meta?: ReactNode;
}

export function PageHeader({ badge, title, subtitle, actions, tone = 'study', eyebrow, meta }: PageHeaderProps) {
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

interface PageSectionProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: Tone;
  className?: string;
}

export function PageSection({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
  tone = 'default',
  className,
}: PageSectionProps) {
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

interface PanelProps {
  as?: ElementType;
  title?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconLike;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  tone?: Tone;
  density?: Density;
  status?: Status;
  interactive?: boolean;
  className?: string;
  // Forward any extra DOM/router props (e.g. `to`, `onClick`, ARIA, data-*).
  [key: string]: unknown;
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
}: PanelProps) {
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

interface StatGridProps {
  children?: ReactNode;
  columns?: number;
  className?: string;
}

export function StatGrid({ children, columns = 3, className }: StatGridProps) {
  return <div className={joinClasses('stat-grid', `stat-grid-${columns}`, className)}>{children}</div>;
}

interface StatCellProps {
  label?: ReactNode;
  value?: ReactNode;
  tone?: Tone;
  detail?: ReactNode;
  className?: string;
}

export function StatCell({ label, value, tone = 'accent', detail, className }: StatCellProps) {
  return (
    <div className={joinClasses('stat-cell', `stat-cell-${tone}`, className)}>
      <small>{label}</small>
      <strong>{value}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

interface EmptyPanelProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: Tone;
  className?: string;
}

export function EmptyPanel({ title, description, action, tone = 'default', className }: EmptyPanelProps) {
  return (
    <Surface tone={tone} className={joinClasses('empty-panel', className)}>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="empty-panel-action">{action}</div>}
    </Surface>
  );
}

interface MetricTileProps {
  label?: ReactNode;
  value?: ReactNode;
  detail?: ReactNode;
  icon?: IconLike;
  tone?: Tone;
  status?: Status;
  className?: string;
}

export function MetricTile({ label, value, detail, icon, tone = 'accent', status, className }: MetricTileProps) {
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

export function MetricCard(props: MetricTileProps) {
  return <MetricTile {...props} />;
}

interface CommandHintProps {
  keys: string | string[];
  label?: ReactNode;
}

export function CommandHint({ keys, label }: CommandHintProps) {
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

interface ProgressRailProps {
  value?: number;
  max?: number;
  label?: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
}

export function ProgressRail({ value = 0, max = 100, label, detail, tone = 'accent' }: ProgressRailProps) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div
      className="progress-rail"
      aria-label={typeof label === 'string' ? label : undefined}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      role="progressbar"
    >
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

interface SegmentedOption {
  value: string;
  label: ReactNode;
  icon?: IconLike;
}

interface SegmentedControlProps {
  label?: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  density?: Density;
}

export function SegmentedControl({ label, options, value, onChange, density = 'default' }: SegmentedControlProps) {
  function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
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
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[nextIndex]?.focus();
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

interface DialogProps {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  labelledBy?: string;
  className?: string;
}

export function Dialog({ title, description, children, actions, onClose, labelledBy, className }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable || dialogRef.current)?.focus?.();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
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
    <div
      className="confirm-dialog"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}
    >
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

interface DataTableRow {
  id: string;
  tone?: Tone;
  cells: ReactNode[];
}

interface DataTableProps {
  columns?: ReactNode[];
  rows?: DataTableRow[];
  empty?: ReactNode;
  className?: string;
}

export function DataTable({ columns = [], rows = [], empty = 'No rows available.', className }: DataTableProps) {
  return (
    <div className={joinClasses('data-panel', className)} role="table">
      {columns.length > 0 && (
        <div className="data-panel-row data-panel-head" role="row">
          {columns.map((column, index) => (
            <span key={index} role="columnheader">{column}</span>
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

interface QuestionStageProps {
  badge?: ReactNode;
  question?: ReactNode;
  objective?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  status?: Status;
}

export function QuestionStage({ badge, question, objective, children, footer, status = 'active' }: QuestionStageProps) {
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

interface CaseExhibit {
  id: string;
  title?: ReactNode;
  content?: ReactNode;
}

interface CaseViewerProps {
  title?: ReactNode;
  children?: ReactNode;
  exhibits?: CaseExhibit[];
}

export function CaseViewer({ title = 'Case Facts', children, exhibits = [] }: CaseViewerProps) {
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

interface RubricCriterion {
  id: string;
  label?: ReactNode;
  description?: ReactNode;
  points: number;
}

interface RubricPanelProps {
  criteria?: RubricCriterion[];
  scores?: Record<string, number>;
  onScore?: (id: string, value: number) => void;
  maxPoints?: number;
  title?: ReactNode;
}

export function RubricPanel({ criteria = [], scores = {}, onScore, maxPoints, title = 'Rubric' }: RubricPanelProps) {
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

interface ReviewItemCardItem {
  id: string;
  path: string;
  type: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  reason?: string;
  retentionPct?: number;
  reasonDetails?: string[];
  weaknessSignals?: Array<{ label: string; impact: ReactNode }>;
}

interface ReviewItemCardProps {
  item: ReviewItemCardItem;
}

export function ReviewItemCard({ item }: ReviewItemCardProps) {
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
        {item.reasonDetails?.length ? (
          <small className="muted-copy">{item.reasonDetails.slice(0, 2).join(' ')}</small>
        ) : null}
        {item.weaknessSignals?.length ? (
          <small className="command-hint">
            Signals: {item.weaknessSignals.slice(0, 2).map((signal) => `${signal.label} (${signal.impact})`).join(' · ')}
          </small>
        ) : null}
      </div>
      <ChevronRight size={18} color="var(--text-muted)" aria-hidden="true" />
    </Surface>
  );
}
