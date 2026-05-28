import { useEffect, useRef } from 'react';

export interface FormulaBlockProps {
  latex: string;
  name?: string;
  description?: string;
  compact?: boolean;
}

export default function FormulaBlock({
  latex,
  name,
  description,
  compact = false,
}: FormulaBlockProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    if (!ref.current) return;
    async function renderFormula() {
      try {
        const { default: katex } = await import('katex');
        if (active && ref.current) {
          katex.render(latex, ref.current, { displayMode: true, throwOnError: false });
        }
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
    <div
      className={compact ? 'formula-card compact' : 'formula-block'}
      role="group"
      tabIndex={0}
      aria-label={name ? `${name} formula` : 'Formula'}
    >
      {name && <div className="formula-title">{name}</div>}
      <div ref={ref} className="formula-render" />
      {description && <div className="formula-description">{description}</div>}
    </div>
  );
}
