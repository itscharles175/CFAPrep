import { Link } from 'react-router-dom';
import { BrainCircuit, Binary, Layers, Flame, LineChart, Target, PieChart, ChevronRight, Cpu } from 'lucide-react';
import { quantModules } from '../../data/catalog';
import { useProgressSummary } from '../../hooks/useProgress';

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
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <div className="badge badge-purple" style={{ marginBottom: 'var(--space-3)' }}>
          <BrainCircuit size={12} /> QUANTITATIVE FINANCE
        </div>
        <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>Mathematical & Computational Finance</h1>
        <p className="section-subtitle">Deep-dive into the mathematical foundations of modern finance</p>
      </div>

      <div className="grid-2">
        {quantModules.map((mod, i) => {
          const Icon = iconMap[mod.id] || Cpu;
          const completed = summary.completedIds.has(`quant:${mod.id}`);
          return (
          <Link
            key={mod.id}
            to={mod.status === 'available' ? `/quant/${mod.id}` : '#'}
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
