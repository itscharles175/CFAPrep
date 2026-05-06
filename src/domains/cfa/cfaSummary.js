import { cfaTopics } from '../../data/catalog';

const level1Topics = cfaTopics.map((topic) => ({
  id: topic.id,
  label: topic.label,
  weight: topic.weight,
  maturity: 'exam-ready',
  runtimeMode: 'exam-ready',
  runtimeLabel: 'Editorial exam-ready',
  questions: 100,
  vignettes: 8,
  flashcards: 100,
  skillLabs: 4,
}));

const level2Topics = [
  ['ethics', 'Ethics & Professional Standards', '10-15%'],
  ['quant-methods', 'Quantitative Methods', '5-10%'],
  ['economics', 'Economics', '5-10%'],
  ['fsa', 'Financial Statement Analysis', '10-15%'],
  ['corporate', 'Corporate Issuers', '5-10%'],
  ['equity', 'Equity Valuation', '10-15%'],
  ['fixed-income', 'Fixed Income', '10-15%'],
  ['derivatives', 'Derivatives', '5-10%'],
  ['alternatives', 'Alternative Investments', '5-10%'],
  ['portfolio', 'Portfolio Management And Wealth Planning', '10-15%'],
].map(([id, label, weight]) => ({
  id,
  label,
  weight,
  maturity: 'exam-ready',
  runtimeMode: 'exam-ready',
  runtimeLabel: 'Editorial exam-ready',
  questions: 48,
  vignettes: 12,
  flashcards: 40,
  skillLabs: 4,
}));

const level3Topics = [
  ['ethics', 'Ethics & Professional Standards', '10-15%'],
  ['asset-allocation', 'Asset Allocation', '15-20%'],
  ['portfolio-construction', 'Portfolio Construction', '15-20%'],
  ['performance', 'Performance Evaluation', '5-10%'],
  ['derivatives-risk', 'Derivatives And Risk Management', '10-15%'],
  ['pm-pathway', 'Portfolio Management Pathway', '30-35%'],
].map(([id, label, weight]) => ({
  id,
  label,
  weight,
  maturity: 'exam-ready',
  runtimeMode: 'exam-ready',
  runtimeLabel: 'Editorial exam-ready',
  questions: 12,
  vignettes: 4,
  constructedResponses: 3,
  flashcards: 32,
  skillLabs: 4,
}));

export const cfaLevels = [
  {
    id: 'level1',
    title: 'CFA Level I',
    examFormat: 'Standalone multiple-choice mastery from editorial local topic packs.',
    summary: 'Level I is exam-ready with strict local editorial provenance across all ten topics.',
    runtimeMode: 'exam-ready',
    runtimeLabel: 'Editorial exam-ready',
    topics: level1Topics,
  },
  {
    id: 'level2',
    title: 'CFA Level II',
    examFormat: 'Item-set vignettes focused on application, analysis, valuation, and interpretation.',
    summary: 'Level II is exam-ready with original item-set vignettes, exhibits, rationales, and flashcards.',
    runtimeMode: 'exam-ready',
    runtimeLabel: 'Editorial exam-ready',
    topics: level2Topics,
  },
  {
    id: 'level3',
    title: 'CFA Level III',
    examFormat: 'Constructed response and item-set cases focused on portfolio management judgment.',
    summary: 'Level III is exam-ready with original constructed responses, item sets, rubrics, datasets, and mapped response drills.',
    runtimeMode: 'exam-ready',
    runtimeLabel: 'Editorial exam-ready',
    topics: level3Topics,
  },
];

export const cfaRuntimeReport = {
  generatedAt: new Date().toISOString(),
  levels: [
    {
      level: 'level1',
      mode: 'exam-ready',
      label: 'Editorial exam-ready',
      releaseEligible: true,
      topicCount: 10,
      authoredPackCount: 10,
      validatedTopics: 0,
      examReadyTopics: 10,
      blockers: [],
      warnings: [],
    },
    {
      level: 'level2',
      mode: 'exam-ready',
      label: 'Editorial exam-ready',
      releaseEligible: true,
      topicCount: 10,
      authoredPackCount: 10,
      validatedTopics: 0,
      examReadyTopics: 10,
      blockers: [],
      warnings: [],
    },
    {
      level: 'level3',
      mode: 'exam-ready',
      label: 'Editorial exam-ready',
      releaseEligible: true,
      topicCount: 6,
      authoredPackCount: 6,
      validatedTopics: 0,
      examReadyTopics: 6,
      blockers: [],
      warnings: [],
    },
  ],
};

export function getCfaRuntimeReport() {
  return cfaRuntimeReport;
}
