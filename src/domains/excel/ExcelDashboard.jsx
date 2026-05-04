import { Link } from 'react-router-dom';
import { Table2, Sigma, DollarSign, TrendingUp, Code, ChevronRight } from 'lucide-react';
import { excelModules } from '../../data/catalog';
import { useProgressSummary } from '../../hooks/useProgress';

const iconMap = {
  fundamentals: Table2,
  'advanced-formulas': Sigma,
  'financial-functions': DollarSign,
  'dcf-modeling': TrendingUp,
  'vba-macros': Code,
};

export default function ExcelDashboard() {
  const summary = useProgressSummary();

  return (
    <div className="page-container">
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <div className="badge badge-green" style={{ marginBottom: 'var(--space-3)' }}>
          <Table2 size={12} /> EXCEL TRAINING
        </div>
        <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>Financial Modeling & Automation</h1>
        <p className="section-subtitle">From fundamentals to advanced VBA — master the spreadsheet</p>
      </div>

      <div className="grid-2">
        {excelModules.map((mod, i) => {
          const Icon = iconMap[mod.id] || Table2;
          const completed = summary.completedIds.has(`excel:${mod.id}`);
          return (
          <Link
            key={mod.id}
            to={mod.status === 'available' ? `/excel/${mod.id}` : '#'}
            className="glass-card animate-fade"
            style={{ animationDelay: `${i * 60}ms`, textDecoration: 'none', color: 'inherit', opacity: mod.status === 'coming' ? 0.5 : 1 }}
            onClick={e => mod.status === 'coming' && e.preventDefault()}
          >
            <div className="flex-between" style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{ width: 40, height: 40, borderRadius: 'var(--radius-md)', background: `${mod.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={20} color={mod.color} />
                </div>
                <div style={{ fontWeight: 600 }}>{mod.label}</div>
              </div>
              {completed ? <span className="badge badge-green">COMPLETE</span> : <ChevronRight size={18} color="var(--text-muted)" />}
            </div>
            <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: 0 }}>{mod.desc}</p>
          </Link>
          );
        })}
      </div>
    </div>
  );
}
