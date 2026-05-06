import { useEffect, useRef } from 'react';

export default function FormulaBlock({ latex, name, description, compact = false }) {
  const ref = useRef(null);

  useEffect(() => {
    let active = true;
    if (!ref.current) return;
    async function renderFormula() {
      try {
        const { default: katex } = await import('katex');
        if (active && ref.current) katex.render(latex, ref.current, { displayMode: true, throwOnError: false });
      } catch {
        if (active && ref.current) ref.current.textContent = latex;
      }
    }
    renderFormula();
    return () => {
      active = false;
    };
  }, [latex]);

  return (
    <div className={compact ? 'formula-card compact' : 'formula-block'} tabIndex={0} aria-label={name ? `${name} formula` : 'Formula'}>
      {name && <div className="formula-title">{name}</div>}
      <div ref={ref} className="formula-render" />
      {description && <div className="formula-description">{description}</div>}
    </div>
  );
}
