import { Link } from 'react-router-dom';
import { Binary, Layers, Flame, LineChart, Target, PieChart, ChevronRight, Cpu } from 'lucide-react';
import { quantModules } from '../../data/catalog';
import { useProgressSummary } from '../../hooks/useProgress';
import { IconFrame, PageHeader, Panel, StatusBadge } from '../../components/ui/Primitives';
import { SourceRail } from '../../components/SourceContext';

const iconMap = {
  probability: Binary,
  'linear-algebra': Layers,
  'stochastic-calc': Flame,
  'derivatives-pricing': LineChart,
  'risk-management': Target,
  'portfolio-optimization': PieChart,
};

export default function QuantDashboard() {
  const summary = useProgressSummary();

  return (
    <div className="page-container">
      <PageHeader
        tone="quant"
        badge="QUANTITATIVE FINANCE"
        title="Mathematical & Computational Finance"
        subtitle="Deep-dive into probability, stochastic processes, pricing engines, risk systems, and portfolio construction through live labs."
        meta={<StatusBadge tone="quant">{quantModules.length} labs</StatusBadge>}
      />

      <SourceRail
        compact
        limit={2}
        title="Optional CFA References"
        subtitle="Supporting material from your private CFA source vault. Quant lessons remain available without it."
        target={{
          kind: 'tool',
          domain: 'quant',
          level: 'level1',
          topicId: 'quant-methods',
          title: 'Quantitative methods risk management portfolio optimization derivatives pricing',
          keywords: quantModules.map((mod) => `${mod.label} ${mod.desc}`),
          route: '/quant',
        }}
      />

      <div className="grid-2">
        {quantModules.map((mod, i) => {
          const Icon = iconMap[mod.id] || Cpu;
          const completed = summary.completedIds.has(`quant:${mod.id}`);
          return (
          <Panel
            as={Link}
            key={mod.id}
            to={mod.status === 'available' ? `/quant/${mod.id}` : '#'}
            tone="quant"
            status={completed ? 'success' : 'quant'}
            interactive={mod.status === 'available'}
            className="module-index-card animate-fade"
            style={{ animationDelay: `${i * 60}ms`, opacity: mod.status === 'coming' ? 0.5 : 1 }}
            onClick={e => mod.status === 'coming' && e.preventDefault()}
          >
            <div className="module-index-head">
              <IconFrame icon={Icon} tone="quant" />
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
