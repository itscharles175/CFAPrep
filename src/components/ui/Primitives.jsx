import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export function PageHeader({ badge, title, subtitle, actions }) {
  return (
    <div className="module-header">
      <div>
        {badge && <div className="badge badge-blue" style={{ marginBottom: 'var(--space-3)' }}>{badge}</div>}
        <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>{title}</h1>
        {subtitle && <p className="section-subtitle" style={{ marginBottom: 0 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export function MetricCard({ label, value, detail, icon: Icon, tone = 'accent' }) {
  return (
    <div className="glass-card no-hover metric-card">
      {Icon && <Icon size={18} color={`var(--${tone})`} />}
      <div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 800 }}>{value}</div>
        {detail && <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{detail}</div>}
      </div>
    </div>
  );
}

export function SegmentedControl({ label, options, value, onChange }) {
  return (
    <div className="segmented-row" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={`btn ${value === option.value ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ReviewItemCard({ item }) {
  return (
    <Link to={item.path} className="glass-card review-item-card" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div>
        <div className="badge badge-purple" style={{ marginBottom: 'var(--space-2)' }}>{item.type.replace('-', ' ')}</div>
        <h3 style={{ margin: 0 }}>{item.title}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)' }}>{item.subtitle}</p>
      </div>
      <ChevronRight size={18} color="var(--text-muted)" />
    </Link>
  );
}
