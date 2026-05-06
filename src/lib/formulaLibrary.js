import { formulaLibrary as staticFormulaLibrary } from '../data/catalog';
import { excelContent } from '../data/excelContent';
import { quantContent } from '../data/quantContent';
import { getCfaLevelContent as getLevel1Content } from '../domains/cfa/cfaLevel1Runtime';
import { getCfaLevelContent as getLevel2Content } from '../domains/cfa/cfaLevel2Runtime';
import { getCfaLevelContent as getLevel3Content } from '../domains/cfa/cfaLevel3Runtime';
import { DEFAULT_LEVEL3_PATHWAY } from '../domains/cfa/cfaLevel3Pathways';

const levelLabels = {
  level1: 'CFA Level I',
  level2: 'CFA Level II',
  level3: 'CFA Level III',
};

function normalizeEntry(entry) {
  return {
    ...entry,
    desc: entry.desc || entry.description || '',
    path: entry.path || '/formulas',
  };
}

function cfaEntriesFromLevel(levelContent) {
  const levelLabel = levelLabels[levelContent.id] || levelContent.title;
  return levelContent.topics.flatMap((topic) =>
    topic.formulas.map((formula) =>
      normalizeEntry({
        category: `${levelLabel} - ${topic.title}`,
        name: formula.name,
        latex: formula.latex,
        desc: formula.description,
        path: `/cfa/${levelContent.id}/${topic.id}`,
        source: 'cfa-pack',
        level: levelContent.id,
        topicId: topic.id,
      }),
    ),
  );
}

function moduleFormulaEntries({ domain, modules, pathPrefix }) {
  return Object.entries(modules).flatMap(([moduleId, module]) =>
    (module.formulas || []).map((formula) =>
      normalizeEntry({
        category: `${domain} - ${module.title}`,
        name: formula.name,
        latex: formula.latex,
        desc: formula.description,
        path: `/${pathPrefix}/${moduleId}`,
        source: `${pathPrefix}-module`,
      }),
    ),
  );
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.category}:${entry.name}:${entry.latex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildFormulaLibrary(options = {}) {
  const level3Pathway = options.level3Pathway || DEFAULT_LEVEL3_PATHWAY;
  return dedupe([
    ...staticFormulaLibrary.map(normalizeEntry),
    ...cfaEntriesFromLevel(getLevel1Content()),
    ...cfaEntriesFromLevel(getLevel2Content()),
    ...cfaEntriesFromLevel(getLevel3Content({ pathway: level3Pathway })),
    ...moduleFormulaEntries({ domain: 'Quant', modules: quantContent, pathPrefix: 'quant' }),
    ...moduleFormulaEntries({ domain: 'Excel', modules: excelContent, pathPrefix: 'excel' }),
  ]);
}
