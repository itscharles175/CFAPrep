import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import FormulaBlock from '../components/FormulaBlock';
import { EmptyPanel, InlineCluster, PageHeader, Panel, StatusBadge } from '../components/ui/Primitives';
import { SourceRail } from '../components/SourceContext';
import { useLevel3Pathway } from '../domains/cfa/useLevel3Pathway';
import { buildFormulaLibrary } from '../lib/formulaLibrary';

function FormulaCard({ formula }) {
  return (
    <Panel tone="study" density="compact" className="formula-library-card">
      <InlineCluster align="between">
        <strong>{formula.name}</strong>
        <StatusBadge tone="accent">{formula.category}</StatusBadge>
      </InlineCluster>
      <FormulaBlock compact latex={formula.latex} />
      <p>{formula.desc}</p>
    </Panel>
  );
}

export default function FormulaLibrary() {
  const [activePathway] = useLevel3Pathway();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const formulaLibrary = useMemo(() => buildFormulaLibrary({ level3Pathway: activePathway }), [activePathway]);

  const categories = ['all', ...new Set(formulaLibrary.map(f => f.category))];

  const filtered = formulaLibrary.filter(f => {
    const matchSearch = !search || f.name.toLowerCase().includes(search.toLowerCase()) || f.desc.toLowerCase().includes(search.toLowerCase()) || f.category.toLowerCase().includes(search.toLowerCase());
    const matchCat = category === 'all' || f.category === category;
    return matchSearch && matchCat;
  });

  return (
    <div className="page-container">
      <PageHeader
        badge="REFERENCE"
        title="Formula Library"
        subtitle="Searchable reference of essential financial formulas, with KaTeX rendering and source-route links."
        meta={<StatusBadge tone="accent">{formulaLibrary.length} formulas</StatusBadge>}
      />

      <Panel tone="default" density="compact" className="filter-panel">
        <div className="topbar-search formula-search">
          <Search size={16} />
          <input type="text" aria-label="Search formulas" placeholder="Search formulas..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <InlineCluster>
          {categories.map(c => (
            <button key={c} className={`btn ${category === c ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setCategory(c)}>
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </InlineCluster>
      </Panel>

      <div className="result-count">
        {filtered.length} formula{filtered.length !== 1 ? 's' : ''} found
      </div>

      <SourceRail
        compact
        limit={2}
        title="Formula Source Context"
        target={{
          kind: 'formula',
          domain: 'cfa',
          level: 'level3',
          pathway: activePathway,
          title: search || (category === 'all' ? 'formula library valuation duration options portfolio' : category),
          formulaNames: filtered.slice(0, 5).map((formula) => formula.name),
          keywords: [category, search, ...filtered.slice(0, 5).map((formula) => formula.desc)].filter(Boolean),
          route: '/formulas',
        }}
      />

      {filtered.length ? (
        <div className="grid-2">
          {filtered.map((f) => <FormulaCard key={`${f.category}-${f.name}`} formula={f} />)}
        </div>
      ) : (
        <EmptyPanel
          title="No formulas match your search"
          description={
            search
              ? `Nothing matched “${search}”. Try a different term, or pick another category.`
              : 'No formulas in this category yet.'
          }
          tone="study"
        />
      )}
    </div>
  );
}
