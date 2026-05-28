import { formulaLibrary as staticFormulaLibrary } from '../data/catalog';
import { excelContent } from '../data/excelContent';
import { quantContent } from '../data/quantContent';
import { getCfaLevelContent as getLevel1Content } from '../domains/cfa/cfaLevel1Runtime';
import { getCfaLevelContent as getLevel2Content } from '../domains/cfa/cfaLevel2Runtime';
import { getCfaLevelContent as getLevel3Content } from '../domains/cfa/cfaLevel3Runtime';
import { DEFAULT_LEVEL3_PATHWAY } from '../domains/cfa/cfaLevel3Pathways';
import type { CfaLevelContent } from '../lib/contentTypes';

export interface FormulaEntryInput {
  category: string;
  name: string;
  latex: string;
  desc?: string;
  description?: string;
  path?: string;
  source?: string;
  level?: string;
  topicId?: string;
}

export interface FormulaEntry extends FormulaEntryInput {
  desc: string;
  path: string;
}

interface FormulaModule {
  title: string;
  formulas?: Array<{ name: string; latex: string; description?: string }>;
}

const levelLabels: Record<string, string> = {
  level1: 'CFA Level I',
  level2: 'CFA Level II',
  level3: 'CFA Level III',
};

function normalizeEntry(entry: FormulaEntryInput): FormulaEntry {
  return {
    ...entry,
    desc: entry.desc || entry.description || '',
    path: entry.path || '/formulas',
  };
}

function cfaEntriesFromLevel(levelContent: CfaLevelContent): FormulaEntry[] {
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

interface ModuleFormulaOptions {
  domain: string;
  modules: Record<string, FormulaModule>;
  pathPrefix: string;
}

function moduleFormulaEntries({ domain, modules, pathPrefix }: ModuleFormulaOptions): FormulaEntry[] {
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

function dedupe(entries: FormulaEntry[]): FormulaEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.category}:${entry.name}:${entry.latex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface BuildFormulaLibraryOptions {
  level3Pathway?: string;
}

export function buildFormulaLibrary(options: BuildFormulaLibraryOptions = {}): FormulaEntry[] {
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
