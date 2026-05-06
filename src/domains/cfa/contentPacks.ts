import type {
  AssessmentBlueprint,
  AuthoredContentPack,
  AuthoredExample,
  AuthoredFlashcard,
  AuthoredLesson,
  AuthoredQuestion,
  AuthoredVignette,
  CfaContentBatch,
  CfaLevelContent,
  CfaTopicContent,
  ContentMaturity,
  ContentPack,
  ContentProvenance,
  ContentRuntimeMode,
  CurriculumLevel,
  CurriculumSourceMeta,
  CurriculumSourceReference,
  CurriculumTopic,
  FlashcardBlueprint,
  FlashcardPack,
  FormulaBlueprint,
  LessonBlueprint,
  MockExam,
  ObjectiveBlueprint,
  ObjectiveToolMapping,
  QuestionPack,
  ReadingExample,
  SkillLab,
  SkillLabMapping,
  TopicDataset,
  VignettePack,
} from '../../lib/contentTypes';
import type { Difficulty, ErrorCategory, Formula, LessonSection } from '../../lib/learningTypes';
import { buildLevel1EditorialPacks } from './level1Packs';
import { enrichCfaFormula } from './formulaLexicon.js';
import { level2AuthoredContentPacks, level2TopicIds } from './level2Packs';
import { level3AuthoredContentPacks, level3TopicIds } from './level3Packs';

const CONTENT_PACK_EXAM_YEAR = 2026;
const LEVEL1_TOPIC_IDS = [
  'ethics',
  'quant-methods',
  'economics',
  'fsa',
  'corporate',
  'equity',
  'fixed-income',
  'derivatives',
  'alternatives',
  'portfolio',
] as const;

export const level1SaturationTargets = {
  objectives: 12,
  lessonSections: 16,
  lessons: 8,
  formulas: 10,
  examples: 12,
  standaloneQuestions: 100,
  vignettes: 8,
  flashcards: 100,
  skillLabs: 4,
} as const;

const publicReferences: CurriculumSourceReference[] = [
  {
    title: 'CFA Level I exam guide',
    url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-i-exam',
    usage: 'exam-format',
  },
  {
    title: 'CFA Level II exam guide',
    url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-ii-exam',
    usage: 'exam-format',
  },
  {
    title: 'CFA Level III exam guide',
    url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-iii-exam',
    usage: 'exam-format',
  },
];

type SkillLabTemplate = {
  toolId: string;
  toolType: SkillLabMapping['toolType'];
  path: string;
  reason: string;
};

type Level1TopicSpec = {
  id: (typeof LEVEL1_TOPIC_IDS)[number];
  title: string;
  examWeight: string;
  focus: string;
  units: string[];
  keyConcepts: string[];
  datasetColumns: string[];
  skillLabs: SkillLabTemplate[];
};

const level1TopicSpecs: Level1TopicSpec[] = [
  {
    id: 'ethics',
    title: 'Ethics & Professional Standards',
    examWeight: '15-20%',
    focus: 'duties, conflicts, independence, market integrity, suitability, and professional conduct judgment',
    units: [
      'Professional Duties And Conduct Triggers',
      'Independence, Objectivity, And Conflicts',
      'Material Nonpublic Information And Market Integrity',
      'Client Duties, Suitability, And Loyalty',
      'Performance Presentation And Communication',
      'Research Objectivity And Supervisory Controls',
      'GIPS-Style Fair Presentation Concepts',
      'Ethics Case Review And Decision Frameworks',
    ],
    keyConcepts: [
      'Duties to clients',
      'Duties to employers',
      'Independence and objectivity',
      'Conflicts disclosure',
      'Priority of transactions',
      'Material nonpublic information',
      'Market manipulation',
      'Suitability',
      'Loyalty and prudence',
      'Fair dealing',
      'Performance presentation',
      'Supervisory responsibility',
    ],
    datasetColumns: ['scenario', 'stakeholder', 'constraint', 'recommended action'],
    skillLabs: [
      { toolId: 'mock:ethics-case-drill', toolType: 'mock', path: '/cfa/level1/ethics/quiz', reason: 'Case drills train clean rule selection under ambiguous facts.' },
      { toolId: 'flashcard:ethics-traps', toolType: 'flashcard', path: '/flashcards', reason: 'Trap cards build rapid recognition of conduct and disclosure cues.' },
    ],
  },
  {
    id: 'quant-methods',
    title: 'Quantitative Methods',
    examWeight: '6-9%',
    focus: 'time value, statistics, probability, sampling, hypothesis testing, regression, and data interpretation',
    units: [
      'Time Value Of Money Mechanics',
      'Discounted Cash Flow Applications',
      'Descriptive Statistics And Distributions',
      'Probability Rules And Expected Value',
      'Sampling And Estimation',
      'Hypothesis Testing Workflow',
      'Correlation And Regression Basics',
      'Data Interpretation And Model Limits',
    ],
    keyConcepts: [
      'Future value',
      'Present value',
      'Effective annual rate',
      'Holding-period return',
      'Arithmetic mean',
      'Geometric mean',
      'Variance',
      'Standard deviation',
      'Expected value',
      'Confidence interval',
      'Test statistic',
      'Regression slope',
    ],
    datasetColumns: ['period', 'cash flow', 'return', 'probability'],
    skillLabs: [
      { toolId: 'calculator:tvm', toolType: 'calculator', path: '/calculators', reason: 'TVM calculators reinforce compounding, discounting, and sign conventions.' },
      { toolId: 'quant:regression-diagnostics', toolType: 'quant-lab', path: '/quant/statistical-analysis', reason: 'Regression diagnostics turn model interpretation into repeatable practice.' },
    ],
  },
  {
    id: 'economics',
    title: 'Economics',
    examWeight: '6-9%',
    focus: 'supply and demand, firm behavior, macro indicators, policy, trade, currency, and business-cycle reasoning',
    units: [
      'Supply Demand And Elasticity',
      'Consumer And Firm Choice',
      'Market Structures And Competition',
      'Aggregate Output And Growth',
      'Inflation, Employment, And Policy',
      'Fiscal And Monetary Transmission',
      'International Trade And Capital Flows',
      'Currency Quotes And Exchange-Rate Logic',
    ],
    keyConcepts: [
      'Price elasticity',
      'Income elasticity',
      'Cross-price elasticity',
      'Marginal revenue',
      'Marginal cost',
      'GDP identity',
      'Inflation rate',
      'Real interest rate',
      'Money multiplier',
      'Purchasing power parity',
      'Interest rate parity',
      'Exchange-rate quote',
    ],
    datasetColumns: ['indicator', 'current value', 'prior value', 'interpretation'],
    skillLabs: [
      { toolId: 'quant:macro-scenarios', toolType: 'quant-lab', path: '/quant/risk-management', reason: 'Scenario labs connect macro facts to rates, currency, and risk interpretation.' },
      { toolId: 'calculator:fx-parity', toolType: 'calculator', path: '/calculators', reason: 'Parity calculations support exchange-rate and inflation reasoning.' },
    ],
  },
  {
    id: 'fsa',
    title: 'Financial Statement Analysis',
    examWeight: '11-14%',
    focus: 'statement links, accruals, ratios, inventories, long-lived assets, taxes, leases, and reporting quality',
    units: [
      'Financial Statements As One System',
      'Accruals, Cash Flow, And Classification',
      'Common-Size And Trend Analysis',
      'Liquidity, Solvency, And Coverage',
      'Profitability And DuPont Decomposition',
      'Inventory And Cost Flow Effects',
      'Long-Lived Assets, Taxes, And Leases',
      'Revenue Quality And Analyst Adjustments',
    ],
    keyConcepts: [
      'Accounting equation',
      'Gross margin',
      'Current ratio',
      'Quick ratio',
      'Debt to equity',
      'Interest coverage',
      'Net profit margin',
      'Asset turnover',
      'Return on equity',
      'DuPont ROE',
      'Indirect operating cash flow',
      'Inventory days',
    ],
    datasetColumns: ['line item', 'year 1', 'year 2', 'analyst note'],
    skillLabs: [
      { toolId: 'excel:financial-statement-grid', toolType: 'excel-drill', path: '/excel/fundamentals', reason: 'Statement grids make links between income, balance sheet, and cash flow active.' },
      { toolId: 'calculator:ratio-analysis', toolType: 'calculator', path: '/calculators', reason: 'Ratio calculators reinforce liquidity, profitability, leverage, and quality interpretation.' },
    ],
  },
  {
    id: 'corporate',
    title: 'Corporate Issuers',
    examWeight: '6-9%',
    focus: 'governance, capital budgeting, cost of capital, leverage, payout policy, and working-capital management',
    units: [
      'Corporate Governance And Agency Issues',
      'Capital Budgeting Decision Rules',
      'Project Cash Flow And Risk',
      'Cost Of Capital Components',
      'Capital Structure And Leverage',
      'Working Capital Management',
      'Payout Policy And Share Repurchases',
      'ESG, Stakeholders, And Corporate Strategy',
    ],
    keyConcepts: [
      'Net present value',
      'Internal rate of return',
      'Payback period',
      'Weighted average cost of capital',
      'Cost of equity',
      'Cost of debt',
      'Operating leverage',
      'Financial leverage',
      'Cash conversion cycle',
      'Dividend payout ratio',
      'Share repurchase yield',
      'Agency cost',
    ],
    datasetColumns: ['project', 'initial outlay', 'annual cash flow', 'risk note'],
    skillLabs: [
      { toolId: 'calculator:npv-irr', toolType: 'calculator', path: '/calculators', reason: 'NPV and IRR drills reinforce project-selection rules and ranking traps.' },
      { toolId: 'excel:scenario-manager', toolType: 'excel-drill', path: '/excel/dcf-modeling', reason: 'Scenario tables make capital-budgeting assumptions visible and auditable.' },
    ],
  },
  {
    id: 'equity',
    title: 'Equity Investments',
    examWeight: '11-14%',
    focus: 'market structure, indexes, industry analysis, company analysis, dividends, valuation models, and multiples',
    units: [
      'Equity Market Structure And Orders',
      'Indexes, Benchmarks, And Market Efficiency',
      'Industry And Competitive Analysis',
      'Company Analysis And Growth Drivers',
      'Dividend Discount Model Mechanics',
      'Free Cash Flow And Residual Income Intuition',
      'Market Multiples And Comparables',
      'Equity Risk, Return, And Review Cases',
    ],
    keyConcepts: [
      'Market capitalization',
      'Price return',
      'Total return',
      'Dividend yield',
      'Gordon growth value',
      'Required return',
      'Retention ratio',
      'Sustainable growth',
      'Price earnings ratio',
      'Enterprise value multiple',
      'Book value per share',
      'Free cash flow yield',
    ],
    datasetColumns: ['company', 'earnings', 'growth', 'multiple'],
    skillLabs: [
      { toolId: 'calculator:gordon-growth', toolType: 'calculator', path: '/calculators', reason: 'Gordon Growth drills connect required return, growth, and intrinsic value.' },
      { toolId: 'excel:dcf-builder', toolType: 'excel-drill', path: '/excel/dcf-modeling', reason: 'DCF builder practice ties forecasts, terminal assumptions, and sensitivity together.' },
    ],
  },
  {
    id: 'fixed-income',
    title: 'Fixed Income',
    examWeight: '11-14%',
    focus: 'bond features, cash flows, valuation, yield, duration, convexity, credit, securitization, and portfolio roles',
    units: [
      'Bond Features And Cash-Flow Promises',
      'Price-Yield Mechanics',
      'Yield Measures And Compounding',
      'Spot Rates, Forward Rates, And Term Structure',
      'Duration And First-Order Rate Risk',
      'Convexity And Large Yield Moves',
      'Curve, Spread, And Credit Risk',
      'Securitization And Portfolio Use Cases',
    ],
    keyConcepts: [
      'Plain bond price',
      'Clean and dirty price',
      'Current yield',
      'Effective annual yield',
      'Spot-rate bond value',
      'Forward rate',
      'Macaulay duration',
      'Modified duration',
      'Duration price change',
      'Convexity adjustment',
      'Credit spread',
      'Expected credit loss',
    ],
    datasetColumns: ['bond', 'coupon', 'maturity', 'yield'],
    skillLabs: [
      { toolId: 'calculator:bond-price', toolType: 'calculator', path: '/calculators', reason: 'Bond price drills turn cash-flow timing and yield mechanics into active practice.' },
      { toolId: 'quant:duration-shock', toolType: 'quant-lab', path: '/quant/risk-management', reason: 'Duration shock scenarios show rate and spread risk in tabular form.' },
    ],
  },
  {
    id: 'derivatives',
    title: 'Derivatives',
    examWeight: '5-8%',
    focus: 'forwards, futures, swaps, options, payoff diagrams, no-arbitrage pricing, hedging, and risk transfer',
    units: [
      'Derivative Markets And Contract Roles',
      'Forward Commitments And Payoffs',
      'Futures Margin And Marking To Market',
      'Swap Cash Flows And Risk Transfer',
      'Option Payoffs And Moneyness',
      'Put-Call Parity And No-Arbitrage',
      'Binomial Intuition And Greeks',
      'Derivative Hedging And Review Cases',
    ],
    keyConcepts: [
      'Forward payoff',
      'Futures margin balance',
      'Swap net payment',
      'Call option payoff',
      'Put option payoff',
      'Intrinsic value',
      'Time value',
      'Put-call parity',
      'Delta',
      'Gamma',
      'Option breakeven',
      'Hedge ratio',
    ],
    datasetColumns: ['contract', 'underlying price', 'strike', 'payoff'],
    skillLabs: [
      { toolId: 'calculator:option-payoff', toolType: 'calculator', path: '/calculators', reason: 'Payoff calculators reinforce sign conventions and breakeven logic.' },
      { toolId: 'quant:binomial-tree', toolType: 'quant-lab', path: '/quant/derivatives', reason: 'Binomial tree labs make no-arbitrage option intuition concrete.' },
    ],
  },
  {
    id: 'alternatives',
    title: 'Alternative Investments',
    examWeight: '7-10%',
    focus: 'real estate, private markets, commodities, hedge funds, fees, liquidity, appraisal, and diversification',
    units: [
      'Alternative Investment Roles And Constraints',
      'Real Estate Cash Flow And Valuation',
      'Private Equity And Venture Capital Basics',
      'Private Debt And Infrastructure Features',
      'Hedge Fund Strategies And Risks',
      'Commodity Return Components',
      'Fees, Liquidity, And Appraisal Risk',
      'Portfolio Fit And Review Cases',
    ],
    keyConcepts: [
      'Net operating income',
      'Capitalization rate',
      'Real estate value',
      'Management fee',
      'Incentive fee',
      'Carried interest',
      'Money multiple',
      'Internal rate of return',
      'Commodity roll yield',
      'Sharpe ratio',
      'Liquidity premium',
      'Appraisal smoothing',
    ],
    datasetColumns: ['asset type', 'cash flow', 'fee input', 'risk cue'],
    skillLabs: [
      { toolId: 'calculator:fee-waterfall', toolType: 'calculator', path: '/calculators', reason: 'Fee waterfall drills expose management fee, incentive fee, and return-sharing mechanics.' },
      { toolId: 'excel:scenario-manager', toolType: 'excel-drill', path: '/excel/dcf-modeling', reason: 'Scenario grids help compare illiquidity, fees, and appraisal assumptions.' },
    ],
  },
  {
    id: 'portfolio',
    title: 'Portfolio Management',
    examWeight: '8-12%',
    focus: 'risk-return tradeoff, diversification, CAPM, allocation, benchmarks, IPS logic, and performance basics',
    units: [
      'Portfolio Risk And Return Foundations',
      'Diversification And Correlation',
      'Capital Allocation And Capital Market Line',
      'CAPM And Security Market Line',
      'Asset Allocation And IPS Basics',
      'Benchmark Selection And Portfolio Fit',
      'Performance Measurement And Attribution',
      'Portfolio Review Cases And Skill Labs',
    ],
    keyConcepts: [
      'Expected portfolio return',
      'Portfolio variance',
      'Covariance',
      'Correlation',
      'Sharpe ratio',
      'Capital asset pricing model',
      'Beta',
      'Treynor ratio',
      'Tracking error',
      'Information ratio',
      'Active return',
      'Rebalancing band',
    ],
    datasetColumns: ['asset', 'expected return', 'standard deviation', 'correlation cue'],
    skillLabs: [
      { toolId: 'quant:efficient-frontier', toolType: 'quant-lab', path: '/quant/portfolio-optimization', reason: 'Efficient-frontier labs connect covariance, risk, and allocation choices.' },
      { toolId: 'calculator:portfolio-statistics', toolType: 'calculator', path: '/calculators', reason: 'Portfolio statistics drills reinforce weighted returns, volatility, and beta.' },
    ],
  },
];

function sourceMeta(status: ContentMaturity, topic: string): CurriculumSourceMeta {
  return {
    original: true,
    examYear: CONTENT_PACK_EXAM_YEAR,
    publicReferences,
    authoringStatus: status,
    notes: `${topic} authored content uses public CFA pages only for exam structure and topic weights; objectives, lessons, examples, questions, vignettes, flashcards, and rationales are original QuantVault material.`,
  };
}

function provenance({
  sourceKind = 'template-spec',
  qualityNotes,
  generatedFromTemplate = true,
  editorialStatus = 'validated',
}: Partial<ContentProvenance> & { qualityNotes: string }): ContentProvenance {
  return {
    author: generatedFromTemplate ? 'QuantVault topic-spec factory' : 'QuantVault editorial author',
    reviewer: 'QuantVault local editorial gate',
    reviewedAt: '2026-05-04',
    sourceKind,
    editorialStatus,
    qualityNotes,
    generatedFromTemplate,
  };
}

function topicKey(level: CurriculumLevel['id'], topicId: string) {
  return level === 'level1' ? topicId : `${level}:${topicId}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function objectiveBlueprints(spec: Level1TopicSpec): ObjectiveBlueprint[] {
  const actions = [
    'Frame the decision context',
    'Classify the core inputs',
    'Calculate the primary measure',
    'Interpret the output',
    'Separate signal from distractor',
    'Compare alternatives',
    'Diagnose common traps',
    'Connect to portfolio use',
    'Apply time-pressure shortcuts',
    'Evaluate assumption quality',
    'Select the best exam response',
    'Review weak-area cues',
  ];

  return actions.map((action, index) => ({
    id: `level1-${spec.id}-obj-${String(index + 1).padStart(2, '0')}`,
    title: `${action} in ${spec.title}`,
    description: `${action} for ${spec.focus}, using only local original scenarios, formulas, exhibits, and answer rationales.`,
    skill: index < 4 ? 'learn-describe' : index < 9 ? 'analyze-evaluate' : 'integrate-apply',
    tags: ['level1', spec.id, slug(action)],
  }));
}

function formulaBlueprints(spec: Level1TopicSpec, objectives: ObjectiveBlueprint[]): FormulaBlueprint[] {
  return spec.keyConcepts.map((concept, index) => {
    const enrichment = enrichCfaFormula({
      level: 'level1',
      topicId: spec.id,
      name: concept,
      index,
    });
    return {
      id: `level1-${spec.id}-formula-${String(index + 1).padStart(2, '0')}`,
      name: concept,
      latex: enrichment.latex,
      description: `${enrichment.description} It is linked to original ${spec.title} practice facts and exam-ready decisions.`,
      objectiveIds: [objectives[index % objectives.length].id, objectives[(index + 3) % objectives.length].id],
    };
  });
}

function lessonBlueprints(spec: Level1TopicSpec, objectives: ObjectiveBlueprint[]): LessonBlueprint[] {
  return spec.units.map((unit, index) => {
    const objectiveIds = [objectives[index % 12].id, objectives[(index + 1) % 12].id, objectives[(index + 4) % 12].id];
    const exampleCount = index < 4 ? 2 : 1;
    return {
      id: `level1-${spec.id}-unit-${String(index + 1).padStart(2, '0')}`,
      title: unit,
      objectiveIds,
      sectionTitles: [`${unit} concept map`, `${unit} exam application`],
      workedExampleTitles: Array.from({ length: exampleCount }, (_, exampleIndex) => `${unit} worked example ${exampleIndex + 1}`),
      commonErrors: [
        `Solving a familiar ${spec.title} problem instead of the facts in the current prompt.`,
        `Ignoring the unit-specific constraint before choosing an answer.`,
      ],
    };
  });
}

function questionPackForLesson(lesson: LessonBlueprint, index: number): QuestionPack {
  return {
    id: `${lesson.id}-standalone-questions`,
    itemType: 'single',
    count: index < 4 ? 13 : 12,
    objectiveIds: lesson.objectiveIds,
    difficultyMix: { foundation: 0.35, intermediate: 0.45, advanced: 0.2 },
    answerRationaleRequired: true,
    formulaReferencePolicy: 'required-where-calculation',
  };
}

function vignettePackForLesson(lesson: LessonBlueprint): VignettePack {
  return {
    id: `${lesson.id}-mini-vignette`,
    count: 1,
    objectiveIds: lesson.objectiveIds,
    questionsPerVignette: 3,
    exhibitTypes: ['facts', 'table', 'calculation'],
  };
}

function flashcardPackForLesson(lesson: LessonBlueprint, index: number): FlashcardPack {
  return {
    id: `${lesson.id}-flashcards`,
    count: index < 4 ? 13 : 12,
    objectiveIds: lesson.objectiveIds,
    sourceTypes: ['definition', 'formula', 'error-pattern'],
  };
}

function assessmentFromQuestionPack(pack: QuestionPack): AssessmentBlueprint {
  const isConstructedResponse = pack.itemType === 'constructed-response';
  return {
    id: `${pack.id}-assessment`,
    itemType: pack.itemType,
    scope: isConstructedResponse ? 'constructed-response-set' : 'standalone',
    count: pack.count,
    objectiveIds: pack.objectiveIds,
    difficultyMix: pack.difficultyMix,
    promptStyle: isConstructedResponse
      ? 'Original Level III constructed response with explicit command words, model answer, and point-scored rubric.'
      : 'Original Level I standalone item with three choices, one best answer, and distractor rationales.',
    notes: isConstructedResponse
      ? 'Constructed-response rows are required before a Level III exam-ready release.'
      : 'Authored question rows are required before an exam-ready release.',
    commandWords: isConstructedResponse ? ['determine', 'justify', 'recommend'] : undefined,
    rubricBands: isConstructedResponse ? ['identify', 'apply', 'justify', 'communicate'] : undefined,
  };
}

function assessmentFromVignettePack(pack: VignettePack, level: CurriculumLevel['id'] = 'level1'): AssessmentBlueprint {
  const isItemSet = level === 'level2' || level === 'level3';
  return {
    id: `${pack.id}-assessment`,
    itemType: 'vignette',
    scope: isItemSet ? 'item-set' : 'mini-vignette',
    count: pack.count,
    objectiveIds: pack.objectiveIds,
    difficultyMix: { foundation: 0.25, intermediate: 0.5, advanced: 0.25 },
    promptStyle: `Original ${isItemSet ? 'item set' : 'mini-vignette'} with ${pack.questionsPerVignette} independently scorable questions and structured exhibits.`,
    notes: `Required exhibits: ${pack.exhibitTypes.join(', ')}.`,
  };
}

function flashcardBlueprintFromPack(pack: FlashcardPack): FlashcardBlueprint {
  return {
    id: `${pack.id}-blueprint`,
    type: pack.sourceTypes.includes('formula') ? 'formula' : pack.sourceTypes.includes('error-pattern') ? 'error-pattern' : 'definition',
    count: pack.count,
    objectiveIds: pack.objectiveIds,
    promptStyle: `Scheduled cards are authored from ${pack.sourceTypes.join(', ')} material in this topic pack.`,
  };
}

function overlaps(left: string[], right: string[]) {
  return left.some((item) => right.includes(item));
}

function pathwayForPack(pack: ContentPack): CurriculumTopic['pathway'] {
  if (pack.level !== 'level3') return undefined;
  if (pack.topicId === 'pm-pathway') return 'portfolio-management';
  if (pack.topicId === 'private-markets-pathway') return 'private-markets';
  if (pack.topicId === 'private-wealth-pathway') return 'private-wealth';
  return 'core';
}

export function contentPackToCurriculumTopic(pack: ContentPack): CurriculumTopic {
  return {
    id: pack.topicId,
    title: pack.title,
    examWeight: pack.examWeight,
    maturity: pack.maturity,
    pathway: pathwayForPack(pack),
    sourceMeta: pack.sourceMeta,
    objectiveBlueprints: pack.objectiveBlueprints,
    formulaBlueprints: pack.formulaBlueprints,
    studyUnits: pack.lessonBlueprints.map((lesson, index) => {
      const questionPacks = pack.questionPacks.filter((questionPack) => questionPack.id.startsWith(lesson.id));
      const vignettePacks = pack.vignettePacks.filter((vignettePack) => vignettePack.id.startsWith(lesson.id));
      const flashcardPacks = pack.flashcardPacks.filter((flashcardPack) => flashcardPack.id.startsWith(lesson.id));
      return {
        id: lesson.id,
        title: lesson.title,
        sequence: index + 1,
        summary: `${lesson.title} authored unit with original sections, examples, assessment rows, vignettes, flashcards, and mapped tools.`,
        objectiveIds: lesson.objectiveIds,
        formulaIds: pack.formulaBlueprints.filter((formula) => overlaps(formula.objectiveIds, lesson.objectiveIds)).map((formula) => formula.id),
        lessonSectionCount: lesson.sectionTitles.length,
        workedExampleCount: lesson.workedExampleTitles.length,
        assessmentBlueprints: [
          ...questionPacks.map(assessmentFromQuestionPack),
          ...vignettePacks.map((vignettePack) => assessmentFromVignettePack(vignettePack, pack.level)),
        ],
        flashcardBlueprints: flashcardPacks.map(flashcardBlueprintFromPack),
        commonErrors: lesson.commonErrors,
      };
    }),
    skillLabMappings: pack.skillLabMappings,
  };
}

function buildDataset(spec: Level1TopicSpec, objectives: ObjectiveBlueprint[]): TopicDataset {
  return {
    id: `level1-${spec.id}-dataset-01`,
    title: `${spec.title} local practice dataset`,
    description: `Compact original dataset for ${spec.title} lessons, examples, mini-vignettes, calculators, and spreadsheet-style drills.`,
    objectiveIds: objectives.slice(0, 6).map((objective) => objective.id),
    columns: spec.datasetColumns,
    rows: Array.from({ length: 6 }, (_, index) =>
      Object.fromEntries(spec.datasetColumns.map((column, columnIndex) => [column, columnIndex === 0 ? `${spec.title} case ${index + 1}` : index + columnIndex + 1])),
    ),
    tags: ['level1', spec.id, 'dataset'],
    provenance: provenance({
      sourceKind: 'local-dataset',
      qualityNotes: `Synthetic local ${spec.title} dataset for examples, exhibits, and tool-lab mappings.`,
    }),
  };
}

function buildAuthoredExamples(spec: Level1TopicSpec, lessons: LessonBlueprint[], objectives: ObjectiveBlueprint[], formulas: FormulaBlueprint[]): AuthoredExample[] {
  return Array.from({ length: level1SaturationTargets.examples }, (_, index) => {
    const lesson = lessons[index % lessons.length];
    const objective = objectives[index % objectives.length];
    const formula = formulas[index % formulas.length];
    return {
      id: `level1-${spec.id}-example-${String(index + 1).padStart(2, '0')}`,
      lessonId: lesson.id,
      objectiveId: objective.id,
      topic: topicKey('level1', spec.id),
      learningObjective: objective.id,
      title: `${spec.title} worked example ${index + 1}`,
      prompt: `A Level I candidate sees a ${lesson.title.toLowerCase()} prompt with one useful fact, one distracting fact, and a time limit.`,
      walkthrough: `Identify the objective, map the relevant fact to ${objective.title.toLowerCase()}, use ${formula.name} only if it directly supports the decision, and state the implication in answer-choice language.`,
      formulaName: formula.name,
      datasetId: `level1-${spec.id}-dataset-01`,
      tags: ['level1', spec.id, 'worked-example'],
      provenance: provenance({
        qualityNotes: `Template-derived worked example scaffold for ${spec.title}; requires line edit before exam-ready promotion.`,
      }),
    };
  });
}

function buildAuthoredLessons(
  spec: Level1TopicSpec,
  lessonBlueprintsForPack: LessonBlueprint[],
  formulas: FormulaBlueprint[],
  examples: AuthoredExample[],
): AuthoredLesson[] {
  return lessonBlueprintsForPack.map((lesson, index) => {
    const formulaIds = formulas.filter((formula) => overlaps(formula.objectiveIds, lesson.objectiveIds)).slice(0, 3).map((formula) => formula.id);
    const sections: LessonSection[] = lesson.sectionTitles.map((title, sectionIndex) => ({
      title,
      content: `${title} teaches ${spec.focus}. The learner starts by naming the relevant inputs, then links the facts to the objective before applying formulas, decision rules, or qualitative judgment. Every section uses original QuantVault wording and avoids official learner-facing text.`,
      keyPoints: [
        `Start with the ${lesson.title.toLowerCase()} decision being tested.`,
        `Match facts to ${spec.title} objectives before looking at choices.`,
        sectionIndex === 0 ? 'Build the concept map before calculating.' : 'Translate the result into exam answer language.',
      ],
    }));
    return {
      id: lesson.id,
      title: lesson.title,
      objectiveIds: lesson.objectiveIds,
      formulaIds,
      sections,
      examples: examples.filter((example) => example.lessonId === lesson.id),
      commonErrors: lesson.commonErrors,
      keyTakeaways: [
        `${lesson.title} is mastered when the candidate can explain the decision rule before computing.`,
        `Mapped skill labs convert ${spec.title} knowledge into local practice artifacts.`,
      ],
      provenance: provenance({
        qualityNotes: `Template-derived lesson scaffold for ${lesson.title}; structurally validated but not final editorial prose.`,
      }),
    };
  });
}

const difficulties: Difficulty[] = ['foundation', 'intermediate', 'advanced'];
const errorCategories: ErrorCategory[] = ['concept', 'calculation', 'formula', 'misread', 'time-pressure', 'none'];

function rotatedOptions(correct: string, distractorOne: string, distractorTwo: string, index: number): { options: [string, string, string]; correct: number } {
  const base = [correct, distractorOne, distractorTwo] as const;
  const shift = index % 3;
  const options = [...base.slice(shift), ...base.slice(0, shift)] as [string, string, string];
  return { options, correct: options.indexOf(correct) };
}

function authoredQuestion(params: {
  spec: Level1TopicSpec;
  id: string;
  index: number;
  objective: ObjectiveBlueprint;
  lesson: LessonBlueprint;
  formula?: FormulaBlueprint;
  itemType?: 'single' | 'vignette';
  vignetteTitle?: string;
}): AuthoredQuestion {
  const { spec, id, index, objective, lesson, formula, itemType = 'single', vignetteTitle } = params;
  const correct = `Apply ${objective.title.toLowerCase()} to the facts supplied before considering adjacent ${spec.title} rules.`;
  const distractorOne = `Choose the most familiar ${spec.title} rule even if the stem asks for a different decision.`;
  const distractorTwo = `Delay the answer because an unrelated data point is not fully specified.`;
  const rotated = rotatedOptions(correct, distractorOne, distractorTwo, index);
  return {
    id,
    level: 'level1',
    topic: topicKey('level1', spec.id),
    learningObjective: objective.id,
    itemType,
    question: `${spec.title} ${itemType === 'single' ? 'standalone' : 'mini-vignette'} item ${index + 1}: ${vignetteTitle ? `${vignetteTitle}. ` : ''}Which response best handles ${lesson.title.toLowerCase()}?`,
    options: rotated.options,
    correct: rotated.correct,
    explanation: `The best answer stays inside the prompt, applies ${objective.title.toLowerCase()}, and avoids adding unsupported assumptions. ${formula ? `${formula.name} supports the calculation or decision cue when the stem calls for it.` : 'The item is primarily conceptual, so the decision rule matters more than arithmetic.'}`,
    difficulty: difficulties[index % difficulties.length],
    tags: ['level1', spec.id, itemType, slug(lesson.title), difficulties[index % difficulties.length]],
    errorCategories,
    formula: formula && index % 2 === 0 ? formula.name : undefined,
    answerRationale: {
      correct: `This choice applies ${objective.title.toLowerCase()} directly to the stated facts.`,
      distractors: [
        'This distractor uses a related rule but ignores the current command word.',
        'This distractor avoids the decision instead of resolving the item.',
      ],
      examTrap: `The trap is substituting a memorized ${spec.title} shortcut for the exact fact pattern.`,
    },
    sourceLessonId: lesson.id,
    provenance: provenance({
      qualityNotes: `Template-derived ${itemType} item for ${spec.title}; needs editorial replacement before exam-ready status.`,
    }),
  };
}

function buildAuthoredQuestions(
  spec: Level1TopicSpec,
  lessons: LessonBlueprint[],
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
): AuthoredQuestion[] {
  return Array.from({ length: level1SaturationTargets.standaloneQuestions }, (_, index) =>
    authoredQuestion({
      spec,
      id: `level1-${spec.id}-question-${String(index + 1).padStart(3, '0')}`,
      index,
      objective: objectives[index % objectives.length],
      lesson: lessons[index % lessons.length],
      formula: formulas[index % formulas.length],
    }),
  );
}

function buildAuthoredVignettes(
  spec: Level1TopicSpec,
  lessons: LessonBlueprint[],
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
): AuthoredVignette[] {
  return lessons.map((lesson, index) => {
    const objectiveIds = lesson.objectiveIds;
    const title = `${spec.title} mini-vignette ${index + 1}: ${lesson.title}`;
    return {
      id: `level1-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}`,
      level: 'level1',
      topic: topicKey('level1', spec.id),
      title,
      stem: `A candidate reviews an original ${spec.title} case built around ${lesson.title.toLowerCase()}. The case includes a relevant fact, a distracting adjacent fact, and a local dataset exhibit so each question can be scored independently.`,
      exhibits: [
        {
          id: `level1-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}-facts`,
          title: 'Case facts',
          type: 'facts',
          content: `${lesson.title} facts include a timing cue, one risk cue, and one decision constraint mapped to ${objectiveIds.join(', ')}.`,
          sourceObjectiveIds: objectiveIds,
        },
        {
          id: `level1-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}-table`,
          title: 'Practice exhibit',
          type: 'table',
          content: `${spec.datasetColumns.join(' | ')} rows from the ${spec.title} local practice dataset.`,
          sourceObjectiveIds: objectiveIds.slice(0, 2),
        },
        {
          id: `level1-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}-calculation`,
          title: 'Calculation cue',
          type: 'calculation',
          content: `${formulas[index % formulas.length].name} is relevant only if the question asks for the linked interpretation.`,
          sourceObjectiveIds: [objectiveIds[0]],
        },
      ],
      questions: Array.from({ length: 3 }, (_, questionIndex) =>
        authoredQuestion({
          spec,
          id: `level1-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}-q-${questionIndex + 1}`,
          index: index * 3 + questionIndex,
          objective: objectives[(index + questionIndex) % objectives.length],
          lesson,
          formula: formulas[(index + questionIndex) % formulas.length],
          itemType: 'vignette',
          vignetteTitle: lesson.title,
        }),
      ),
      objectiveIds,
      datasetIds: [`level1-${spec.id}-dataset-01`],
      difficulty: difficulties[index % difficulties.length],
      tags: ['level1', spec.id, 'mini-vignette'],
      learningObjectives: objectiveIds,
      provenance: provenance({
        qualityNotes: `Template-derived mini-vignette scaffold for ${lesson.title}; exhibits and questions require editorial review before exam-ready status.`,
      }),
    };
  });
}

function buildAuthoredFlashcards(
  spec: Level1TopicSpec,
  lessons: LessonBlueprint[],
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
): AuthoredFlashcard[] {
  const objectiveCards = objectives.flatMap((objective, index) =>
    [
      ['definition', objective.title, objective.description, 'objective'],
      ['definition', `${objective.title} decision cue`, `Ask which fact changes the ${spec.title} decision before calculating.`, 'objective'],
      ['error-pattern', `${objective.title} common miss`, `Common miss: solving the adjacent rule instead of applying ${objective.title.toLowerCase()}.`, 'common-error'],
      ['definition', `${objective.title} pacing cue`, 'Write the command word and unit before reading answer choices.', 'objective'],
    ].map(([type, front, back, sourceKind], cardIndex) => ({
      id: `level1-${spec.id}-objective-card-${String(index + 1).padStart(2, '0')}-${cardIndex + 1}`,
      level: 'level1' as const,
      domain: 'cfa' as const,
      topic: topicKey('level1', spec.id),
      type: type as AuthoredFlashcard['type'],
      front,
      back,
      sourcePath: `/cfa/level1/${spec.id}`,
      objectiveId: objective.id,
      sourceKind: sourceKind as AuthoredFlashcard['sourceKind'],
      tags: ['level1', spec.id, 'objective'],
      provenance: provenance({
        qualityNotes: `Template-derived objective card for ${spec.title}; requires editorial polish before exam-ready release.`,
      }),
    })),
  );

  const formulaCards = formulas.flatMap((formula, index) =>
    [
      [`${formula.name} formula`, `${formula.latex}\n\n${formula.description}`],
      [`${formula.name} use case`, `Use this concept when a ${spec.title} prompt supplies the matching input and asks for the linked decision.`],
      [`${formula.name} trap`, 'Check units, sign, and whether the item asks for most likely, least likely, or best action.'],
    ].map(([front, back], cardIndex) => ({
      id: `level1-${spec.id}-formula-card-${String(index + 1).padStart(2, '0')}-${cardIndex + 1}`,
      level: 'level1' as const,
      domain: 'cfa' as const,
      topic: topicKey('level1', spec.id),
      type: cardIndex === 0 ? 'formula' as const : 'definition' as const,
      front,
      back,
      sourcePath: `/cfa/level1/${spec.id}`,
      objectiveId: formula.objectiveIds[0],
      sourceKind: 'formula' as const,
      tags: ['level1', spec.id, 'formula'],
      provenance: provenance({
        qualityNotes: `Template-derived formula card for ${formula.name}; formula linkage is validated, wording requires editorial review.`,
      }),
    })),
  );

  const errorCards = lessons.flatMap((lesson, index) =>
    lesson.commonErrors.map((error, errorIndex) => ({
      id: `level1-${spec.id}-error-card-${String(index + 1).padStart(2, '0')}-${errorIndex + 1}`,
      level: 'level1' as const,
      domain: 'cfa' as const,
      topic: topicKey('level1', spec.id),
      type: 'error-pattern' as const,
      front: `${lesson.title} error ${errorIndex + 1}`,
      back: error,
      sourcePath: `/cfa/level1/${spec.id}`,
      objectiveId: lesson.objectiveIds[errorIndex % lesson.objectiveIds.length],
      sourceKind: 'common-error' as const,
      tags: ['level1', spec.id, 'error-pattern'],
      provenance: provenance({
        qualityNotes: `Template-derived error-pattern card for ${lesson.title}; validated as a review scaffold.`,
      }),
    })),
  );

  return [...objectiveCards, ...formulaCards, ...errorCards].slice(0, level1SaturationTargets.flashcards);
}

function buildSkillMappings(spec: Level1TopicSpec, objectives: ObjectiveBlueprint[]): SkillLabMapping[] {
  const expandedLabs: SkillLabTemplate[] = [
    ...spec.skillLabs,
    {
      toolId: `formula:${spec.id}-drill`,
      toolType: 'formula-drill',
      path: '/flashcards',
      reason: `Formula and concept drills schedule ${spec.title} weak spots into the local review queue.`,
    },
    {
      toolId: `mock:${spec.id}-topic-exam`,
      toolType: 'mock',
      path: `/cfa/level1/${spec.id}/quiz`,
      reason: `Topic exam practice records ${spec.title} accuracy, pacing, confidence, and error categories.`,
    },
  ];
  return expandedLabs.map((lab, index) => ({
    id: `level1-${spec.id}-skill-lab-${String(index + 1).padStart(2, '0')}`,
    objectiveIds: [objectives[index % objectives.length].id, objectives[(index + 4) % objectives.length].id],
    toolId: lab.toolId,
    toolType: lab.toolType,
    path: lab.path,
    reason: lab.reason,
  }));
}

function buildAuthoredContentPack(spec: Level1TopicSpec): AuthoredContentPack {
  const objectives = objectiveBlueprints(spec);
  const formulas = formulaBlueprints(spec, objectives);
  const lessons = lessonBlueprints(spec, objectives);
  const examples = buildAuthoredExamples(spec, lessons, objectives, formulas);
  return {
    id: `level1-${spec.id}-authored-pack`,
    level: 'level1',
    topicId: spec.id,
    title: spec.title,
    examWeight: spec.examWeight,
    maturity: 'validated',
    sourceMeta: sourceMeta('validated', spec.title),
    objectiveBlueprints: objectives,
    lessonBlueprints: lessons,
    formulaBlueprints: formulas,
    questionPacks: lessons.map(questionPackForLesson),
    vignettePacks: lessons.map(vignettePackForLesson),
    flashcardPacks: lessons.map(flashcardPackForLesson),
    skillLabMappings: buildSkillMappings(spec, objectives),
    authoringReview: {
      reviewer: 'QuantVault local editorial gate',
      status: 'validated',
      reviewedAt: '2026-05-04',
      notes: 'Full Level I saturation scaffold with local original lessons, examples, standalone questions, mini-vignettes, flashcards, and mapped skill labs. Promotion to exam-ready requires row-level editorial replacement of template-derived material.',
      checks: [
        'original-wording',
        'objective-coverage',
        'answer-key',
        'distractors',
        'formula-links',
        'vignette-completeness',
        'skill-lab-mapping',
        'accessibility',
      ],
    },
    provenance: provenance({
      qualityNotes: `${spec.title} is structurally saturated and validated, but generatedFromTemplate rows block exam-ready promotion until editorial authoring replaces them.`,
    }),
    datasets: [buildDataset(spec, objectives)],
    authoredExamples: examples,
    authoredLessons: buildAuthoredLessons(spec, lessons, formulas, examples),
    authoredQuestions: buildAuthoredQuestions(spec, lessons, objectives, formulas),
    authoredVignettes: buildAuthoredVignettes(spec, lessons, objectives, formulas),
    authoredFlashcards: buildAuthoredFlashcards(spec, lessons, objectives, formulas),
  };
}

export const level1ValidatedContentPacks: AuthoredContentPack[] = level1TopicSpecs.map(buildAuthoredContentPack);
export const level1AuthoredContentPacks: AuthoredContentPack[] = buildLevel1EditorialPacks(level1ValidatedContentPacks);
export const fsaLevel1ContentPack = level1AuthoredContentPacks.find((pack) => pack.topicId === 'fsa') as AuthoredContentPack;
export { level2AuthoredContentPacks, level3AuthoredContentPacks };

export const level1SaturationBatch: CfaContentBatch = {
  id: 'level1-saturation-batch-2026',
  title: 'Level I Full Saturation Batch',
  sequence: 1,
  level: 'level1',
  topicIds: [...LEVEL1_TOPIC_IDS],
  maturity: 'validated',
  packs: level1AuthoredContentPacks,
  acceptanceCriteria: [
    'Every Level I topic has a full authored content pack with 12 objectives, 16 lesson sections, 12 worked examples, 100 standalone questions, 8 mini-vignettes, 100 flashcards, formulas or key concepts, datasets, and mapped labs.',
    'Runtime Level I content switches to authored packs only after all topic packs pass authored-pack validation.',
    'All learner-facing content is original and public CFA sources are used only for structural alignment.',
    'The app remains local-only with deterministic scheduling, scoring, and import/export behavior.',
  ],
};

export const level2SaturationBatch: CfaContentBatch = {
  id: 'level2-saturation-batch-2026',
  title: 'Level II Full Item-Set Saturation Batch',
  sequence: 2,
  level: 'level2',
  topicIds: [...level2TopicIds],
  maturity: 'exam-ready',
  packs: level2AuthoredContentPacks,
  acceptanceCriteria: [
    'Every Level II topic has a strict authored content pack with 8 objectives, 8 study units, 12 item-set vignettes, 40 flashcards, datasets, formulas or key concepts, and mapped skill labs.',
    'All Level II item sets use original QuantVault wording and public CFA sources only for structure, format, and topic weights.',
    'Level II public exam-ready status is all-or-nothing across all ten topics.',
  ],
};

export const level3SaturationBatch: CfaContentBatch = {
  id: 'level3-saturation-batch-2026',
  title: 'Level III Constructed Response Saturation Batch',
  sequence: 3,
  level: 'level3',
  topicIds: [...level3TopicIds],
  maturity: 'exam-ready',
  packs: level3AuthoredContentPacks,
  acceptanceCriteria: [
    'Every Level III topic has a strict authored content pack with 8 objectives, command-word study units, 4 item-set vignettes, 3 constructed-response cases, rubrics, datasets, flashcards, and mapped labs.',
    'All Level III constructed responses and item sets use original QuantVault wording and public CFA sources only for structure, format, and topic weights.',
    'Level III public exam-ready status is all-or-nothing across core topics and all three pathway topics.',
  ],
};

export const cfaContentBatches: CfaContentBatch[] = [level1SaturationBatch, level2SaturationBatch, level3SaturationBatch];

export function getContentPacks(level?: string, topicId?: string): ContentPack[] {
  return cfaContentBatches
    .flatMap((batch) => batch.packs)
    .filter((pack) => (!level || pack.level === level) && (!topicId || pack.topicId === topicId));
}

export function getAuthoredContentPacks(level?: string, topicId?: string): AuthoredContentPack[] {
  return getContentPacks(level, topicId).filter((pack): pack is AuthoredContentPack => 'authoredQuestions' in pack);
}

export function getContentPack(level: string, topicId: string): ContentPack | null {
  return getContentPacks(level, topicId)[0] || null;
}

export function getAuthoredContentPack(level: string, topicId: string): AuthoredContentPack | null {
  return getAuthoredContentPacks(level, topicId)[0] || null;
}

function skillLabFromMapping(mapping: SkillLabMapping, pack: AuthoredContentPack): SkillLab {
  return {
    id: mapping.id,
    title: `${pack.title} ${mapping.toolType.replace('-', ' ')} lab`,
    domain: 'cfa',
    topic: topicKey(pack.level, pack.topicId),
    type: mapping.toolType === 'mock' || mapping.toolType === 'flashcard' ? 'formula-drill' : mapping.toolType,
    path: mapping.path,
    objectiveIds: mapping.objectiveIds,
    artifactType: mapping.toolType === 'excel-drill' ? 'excel-grid' : mapping.toolType === 'quant-lab' ? 'quant-lab' : 'calculator',
    description: mapping.reason,
  };
}

function toolMappingFromSkillLab(mapping: SkillLabMapping): ObjectiveToolMapping[] {
  return mapping.objectiveIds.map((objectiveId) => ({
    objectiveId,
    toolId: mapping.toolId,
    toolType: mapping.toolType,
    path: mapping.path,
    reason: mapping.reason,
  }));
}

function runtimeLabel(mode: ContentRuntimeMode) {
  if (mode === 'exam-ready') return 'Editorial exam-ready';
  if (mode === 'validated-beta') return 'Validated authored beta';
  return 'Generated scaffold';
}

export function buildRuntimeTopicFromPack(
  pack: AuthoredContentPack,
  runtimeMode: ContentRuntimeMode = 'validated-beta',
): CfaTopicContent {
  const formulas: Formula[] = pack.formulaBlueprints.map((formula) => ({
    name: formula.name,
    latex: formula.latex,
    description: formula.description,
  }));
  const formulasById = new Map(pack.formulaBlueprints.map((formula) => [formula.id, formulas.find((item) => item.name === formula.name) as Formula]));
  const readings = pack.authoredLessons.map((lesson) => ({
    id: `${lesson.id}-reading`,
    topic: topicKey(pack.level, pack.topicId),
    title: lesson.title,
    sections: lesson.sections,
    formulas: lesson.formulaIds.map((formulaId) => formulasById.get(formulaId)).filter(Boolean) as Formula[],
    examples: lesson.examples,
  }));
  const sections = pack.authoredLessons.flatMap((lesson) => lesson.sections);
  const examples = pack.authoredExamples as ReadingExample[];
  const skillLabs = pack.skillLabMappings.map((mapping) => skillLabFromMapping(mapping, pack));
  const toolMappings = pack.skillLabMappings.flatMap(toolMappingFromSkillLab);

  return {
    id: pack.topicId,
    level: pack.level,
    topic: topicKey(pack.level, pack.topicId),
    title: pack.title,
    weight: pack.examWeight,
    maturity: pack.maturity,
    readings,
    sections,
    examples,
    learningObjectives: pack.objectiveBlueprints.map((objective) => ({
      id: objective.id,
      domain: 'cfa',
      topic: topicKey(pack.level, pack.topicId),
      title: objective.title,
      description: objective.description,
      weight: 'exam-ready',
      tags: objective.tags,
    })),
    formulas,
    questions: pack.authoredQuestions,
    vignettes: pack.authoredVignettes,
    constructedResponses: pack.authoredConstructedResponses || [],
    flashcards: pack.authoredFlashcards,
    skillLabs,
    toolMappings,
    sourceMeta: {
      original: true,
      curriculumMap: `${pack.level}:${pack.topicId}`,
      authoringStatus: pack.maturity,
      runtimeMode,
      runtimeLabel: runtimeLabel(runtimeMode),
    },
    runtimeMode,
    runtimeLabel: runtimeLabel(runtimeMode),
  };
}

function buildLevel1AuthoredMocks(topics: CfaTopicContent[]): MockExam[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `level1-mixed-mock-${index + 1}`,
    level: 'level1',
    title: `Level I Authored Mixed Mock ${index + 1}`,
    durationMinutes: 135,
    topics: topics.map((topic) => topic.id),
    questionIds: topics.flatMap((topic) => topic.questions.slice(index * 3, index * 3 + 5).map((question) => question.id)),
    vignetteIds: topics.flatMap((topic) => topic.vignettes.slice(index, index + 1).map((vignette) => vignette.id)),
    constructedResponseIds: [],
    itemTypes: ['single', 'vignette'],
  }));
}

function buildAuthoredMocks(level: CurriculumLevel['id'], topics: CfaTopicContent[]): MockExam[] {
  if (level === 'level1') return buildLevel1AuthoredMocks(topics);
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${level}-mixed-mock-${index + 1}`,
    level,
    title: `${level.replace('level', 'Level ')} Authored Mixed Mock ${index + 1}`,
    durationMinutes: 132,
    topics: topics.map((topic) => topic.id),
    questionIds: topics.flatMap((topic) => topic.questions.slice(index * 2, index * 2 + 2).map((question) => question.id)),
    vignetteIds: topics.flatMap((topic) => topic.vignettes.slice(index, index + 2).map((vignette) => vignette.id)),
    constructedResponseIds:
      level === 'level3'
        ? topics.flatMap((topic) => topic.constructedResponses.slice(index % 3, (index % 3) + 1).map((item) => item.id))
        : [],
    itemTypes: level === 'level2' ? ['vignette'] : ['constructed-response', 'vignette'],
  }));
}

export function buildRuntimeLevelFromPacks(
  level: CurriculumLevel['id'] = 'level1',
  runtimeMode: ContentRuntimeMode = getAuthoredRuntimeMode(level),
): CfaLevelContent {
  const packs = getAuthoredContentPacks(level);
  const topics = packs.map((pack) => buildRuntimeTopicFromPack(pack, runtimeMode));
  return {
    id: level,
    title: level === 'level1' ? 'CFA Level I' : level === 'level2' ? 'CFA Level II' : 'CFA Level III',
    examFormat: level === 'level1' ? 'Standalone multiple-choice mastery from authored local topic packs.' : 'Authored pack runtime shell.',
    summary:
      runtimeMode === 'exam-ready'
        ? 'Editorial-authored local topic packs with exam-ready provenance and release gates.'
        : 'Validated beta authored runtime generated from topic-owned content packs, including lessons, examples, questions, vignettes, flashcards, datasets, and mapped tools.',
    topics,
    mockExams: buildAuthoredMocks(level, topics),
    constructedResponses: topics.flatMap((topic) => topic.constructedResponses),
    sourceMeta: {
      original: true,
      curriculumMap: level,
      authoringStatus: packs.every((pack) => pack.maturity === 'exam-ready') ? 'exam-ready' : 'draft',
      runtimeMode,
      runtimeLabel: runtimeLabel(runtimeMode),
    },
    runtimeMode,
    runtimeLabel: runtimeLabel(runtimeMode),
  };
}

export function hasCompleteLevel1AuthoredRuntime(): boolean {
  return hasCompleteAuthoredRuntime('level1');
}

export function hasCompleteLevel1ValidatedRuntime(): boolean {
  const packIds = new Set(level1AuthoredContentPacks.map((pack) => pack.topicId));
  return (
    LEVEL1_TOPIC_IDS.every((topicId) => packIds.has(topicId)) &&
    level1AuthoredContentPacks.every((pack) => pack.maturity === 'validated' || pack.maturity === 'exam-ready')
  );
}

function expectedTopicIdsForLevel(level: CurriculumLevel['id']) {
  if (level === 'level1') return [...LEVEL1_TOPIC_IDS];
  if (level === 'level2') return [...level2TopicIds];
  if (level === 'level3') return [...level3TopicIds];
  return [];
}

export function hasCompleteAuthoredRuntime(level: CurriculumLevel['id'] = 'level1'): boolean {
  const packs = getAuthoredContentPacks(level);
  const expectedTopicIds = expectedTopicIdsForLevel(level);
  const packIds = new Set(packs.map((pack) => pack.topicId));
  return expectedTopicIds.length > 0 && expectedTopicIds.every((topicId) => packIds.has(topicId)) && packs.every((pack) => pack.maturity === 'exam-ready');
}

export function hasCompleteValidatedRuntime(level: CurriculumLevel['id'] = 'level1'): boolean {
  const packs = getAuthoredContentPacks(level);
  const expectedTopicIds = expectedTopicIdsForLevel(level);
  const packIds = new Set(packs.map((pack) => pack.topicId));
  return (
    expectedTopicIds.length > 0 &&
    expectedTopicIds.every((topicId) => packIds.has(topicId)) &&
    packs.every((pack) => pack.maturity === 'validated' || pack.maturity === 'exam-ready')
  );
}

export function getAuthoredRuntimeMode(level: CurriculumLevel['id'] = 'level1'): ContentRuntimeMode {
  if (hasCompleteAuthoredRuntime(level)) return 'exam-ready';
  if (hasCompleteValidatedRuntime(level)) return 'validated-beta';
  return 'generated';
}

export function getLevel1AuthoredRuntimeMode(): ContentRuntimeMode {
  return getAuthoredRuntimeMode('level1');
}

export function getRuntimeStatus(level: CurriculumLevel['id'] = 'level1') {
  const packs = getAuthoredContentPacks(level);
  const expectedTopicIds = expectedTopicIdsForLevel(level);
  const packIds = new Set(packs.map((pack) => pack.topicId));
  const missingTopics = expectedTopicIds.filter((topicId) => !packIds.has(topicId));
  const mode = getAuthoredRuntimeMode(level);
  const examReadyTopics = packs.filter((pack) => pack.maturity === 'exam-ready').length;
  const validatedTopics = packs.filter((pack) => pack.maturity === 'validated').length;
  return {
    level,
    mode,
    label: runtimeLabel(mode),
    releaseEligible: mode === 'exam-ready',
    topicCount: expectedTopicIds.length,
    authoredPackCount: packs.length,
    validatedTopics,
    examReadyTopics,
    blockers:
      mode === 'exam-ready'
        ? []
        : [
            missingTopics.length
              ? `${missingTopics.length} ${level.replace('level', 'Level ')} topic packs are missing.`
              : `${level.replace('level', 'Level ')} authored runtime is beta because packs are structurally validated but not editorial exam-ready.`,
          ],
    warnings:
      mode === 'validated-beta'
        ? ['Validated beta content is usable locally, but public release remains blocked by editorial provenance gates.']
        : [],
  };
}

export function getLevel1RuntimeStatus() {
  return getRuntimeStatus('level1');
}

export function getLevel2RuntimeStatus() {
  return getRuntimeStatus('level2');
}

export function getLevel3RuntimeStatus() {
  return getRuntimeStatus('level3');
}
