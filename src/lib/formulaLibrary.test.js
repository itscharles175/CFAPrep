import { describe, expect, it } from 'vitest';
import { buildFormulaLibrary } from './formulaLibrary';
import { isGenericCfaFormulaText } from '../domains/cfa/formulaLexicon';
import { getCfaLevelContent as getLevel1Content } from '../domains/cfa/cfaLevel1Runtime';
import { getCfaLevelContent as getLevel2Content } from '../domains/cfa/cfaLevel2Runtime';
import { getCfaLevelContent as getLevel3Content } from '../domains/cfa/cfaLevel3Runtime';

function cfaFormulas(level3Pathway = 'portfolio-management') {
  return [getLevel1Content(), getLevel2Content(), getLevel3Content({ pathway: level3Pathway })].flatMap((level) =>
    level.topics.flatMap((topic) => topic.formulas),
  );
}

describe('formula library integration', () => {
  it('builds the formula reference from runtime CFA packs plus tool modules', () => {
    const library = buildFormulaLibrary({ level3Pathway: 'private-markets' });

    expect(library.length).toBeGreaterThan(250);
    expect(library.some((formula) => formula.category.startsWith('CFA Level II') && formula.name === 'DCF value bridge')).toBe(true);
    expect(library.some((formula) => formula.category === 'Excel - DCF Modeling' && formula.name === 'Terminal Value')).toBe(true);
    expect(library.some((formula) => formula.category === 'Quant - Risk Management' && formula.name === 'Expected Shortfall')).toBe(true);
  });

  it('does not ship generic CFA formula placeholders in runtime formula rows', () => {
    const formulas = cfaFormulas('private-wealth');

    expect(formulas.length).toBeGreaterThan(230);
    expect(formulas.filter((formula) => isGenericCfaFormulaText(formula.latex))).toEqual([]);
    expect(formulas.some((formula) => formula.name === 'Future value' && formula.latex.includes('PV(1+r)^N'))).toBe(true);
    expect(formulas.some((formula) => formula.name === 'After-tax liquidity need' && formula.latex.includes('After-tax cash need'))).toBe(true);
  });
});
