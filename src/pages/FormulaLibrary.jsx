import { useState } from 'react';
import { Library, Search } from 'lucide-react';
import { formulaLibrary } from '../data/catalog';
import FormulaBlock from '../components/FormulaBlock';

function FormulaCard({ formula }) {
  return (
    <div className="glass-card no-hover" style={{ padding: 'var(--space-4) var(--space-5)' }}>
      <div className="flex-between" style={{ marginBottom: 'var(--space-2)' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{formula.name}</span>
        <span className="badge badge-blue">{formula.category}</span>
      </div>
      <FormulaBlock compact latex={formula.latex} />
      <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', margin: 0 }}>{formula.desc}</p>
    </div>
  );
}

export default function FormulaLibrary() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');

  const categories = ['all', ...new Set(formulaLibrary.map(f => f.category))];

  const filtered = formulaLibrary.filter(f => {
    const matchSearch = !search || f.name.toLowerCase().includes(search.toLowerCase()) || f.desc.toLowerCase().includes(search.toLowerCase()) || f.category.toLowerCase().includes(search.toLowerCase());
    const matchCat = category === 'all' || f.category === category;
    return matchSearch && matchCat;
  });

  return (
    <div className="page-container">
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <div className="badge badge-blue" style={{ marginBottom: 'var(--space-3)' }}><Library size={12} /> REFERENCE</div>
        <h1 className="section-title" style={{ fontSize: 'var(--fs-3xl)' }}>Formula Library</h1>
        <p className="section-subtitle">Searchable reference of essential financial formulas</p>
      </div>

      <div className="flex-between" style={{ marginBottom: 'var(--space-6)', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div className="topbar-search" style={{ width: 320 }}>
          <Search size={16} />
          <input type="text" placeholder="Search formulas..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {categories.map(c => (
            <button key={c} className={`btn ${category === c ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setCategory(c)}>
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}>
        {filtered.length} formula{filtered.length !== 1 ? 's' : ''} found
      </div>

      <div className="grid-2">
        {filtered.map((f) => <FormulaCard key={`${f.category}-${f.name}`} formula={f} />)}
      </div>
    </div>
  );
}
