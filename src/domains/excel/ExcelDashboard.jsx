import { Link } from 'react-router-dom';
import { Table2, Sigma, DollarSign, TrendingUp, Code, ChevronRight } from 'lucide-react';
import { excelModules } from '../../data/catalog';
import { useProgressSummary } from '../../hooks/useProgress';
import { IconFrame, PageHeader, Panel, StatusBadge } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';

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
      <PageHeader
        tone="excel"
        badge="EXCEL TRAINING"
        title="Financial Modeling & Automation"
        subtitle="Practice spreadsheet workflows, formula design, finance functions, DCF modeling, audit controls, and automation safety."
        meta={<StatusBadge tone="excel">{excelModules.length} drills</StatusBadge>}
      />

      <SourceRail
        compact
        limit={2}
        title="Optional CFA References"
        subtitle="Supporting material from your private CFA source vault. Excel lessons remain available without it."
        target={{
          kind: 'tool',
          domain: 'excel',
          level: 'level2',
          topicId: 'equity',
          title: 'Financial modeling Excel DCF valuation functions',
          keywords: excelModules.map((mod) => `${mod.label} ${mod.desc}`),
          route: '/excel',
        }}
      />

      <div className="grid-2">
        {excelModules.map((mod, i) => {
          const Icon = iconMap[mod.id] || Table2;
          const completed = summary.completedIds.has(`excel:${mod.id}`);
          return (
          <Panel
            as={Link}
            key={mod.id}
            to={mod.status === 'available' ? `/excel/${mod.id}` : '#'}
            tone="excel"
            status={completed ? 'success' : 'excel'}
            interactive={mod.status === 'available'}
            className="module-index-card animate-fade"
            style={{ animationDelay: `${i * 60}ms`, opacity: mod.status === 'coming' ? 0.5 : 1 }}
            onClick={e => mod.status === 'coming' && e.preventDefault()}
          >
            <div className="module-index-head">
              <IconFrame icon={Icon} tone="excel" />
              <div>
                <h3>{mod.label}</h3>
                <p>{mod.desc}</p>
              </div>
              {completed ? <StatusBadge tone="success">Complete</StatusBadge> : <ChevronRight size={18} color="var(--text-muted)" />}
            </div>
          </Panel>
          );
        })}
      </div>
    </div>
  );
}
