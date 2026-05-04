import { cfaTopics } from '../../data/catalog';
import { getCurriculumTopic } from './curriculumMap';
import {
  buildRuntimeLevelFromPacks,
  getLevel1AuthoredRuntimeMode,
  getLevel1RuntimeStatus,
} from './contentPacks';
import { cfaContent, cfaLearningObjectives, cfaQuizzes } from './cfaData';

const levelMaturity = {
  level1: 'draft',
  level2: 'draft',
  level3: 'draft',
};

function topicMaturity(level, topicId) {
  return getCurriculumTopic(level, topicId)?.maturity || levelMaturity[level];
}

const level1Topics = cfaTopics.map((topic) => ({
  id: topic.id,
  title: topic.label,
  weight: topic.weight,
  summary: `Level I foundation coverage for ${topic.label}, focused on recognition, calculation, and exam-day traps.`,
}));

const level2Topics = [
  ['ethics', 'Ethics & Professional Standards', '10-15%', 'case-based application of duties, conflicts, and professional judgment'],
  ['quant-methods', 'Quantitative Methods', '5-10%', 'regression, time series, machine learning intuition, and model diagnostics'],
  ['economics', 'Economics', '5-10%', 'currency, growth, regulation, and macro scenario interpretation'],
  ['fsa', 'Financial Statement Analysis', '10-15%', 'intercorporate investments, pensions, multinationals, quality, and adjustments'],
  ['corporate', 'Corporate Issuers', '5-10%', 'capital structure, governance, payout, and project analysis'],
  ['equity', 'Equity Valuation', '10-15%', 'DCF, residual income, private company valuation, and multiples'],
  ['fixed-income', 'Fixed Income', '10-15%', 'term structure, credit, embedded options, and structured products'],
  ['derivatives', 'Derivatives', '5-10%', 'option pricing, swaps, forwards, and risk-neutral valuation'],
  ['alternatives', 'Alternative Investments', '5-10%', 'private equity, real estate, commodities, and hedge fund valuation'],
  ['portfolio', 'Portfolio Management', '10-15%', 'active management, factor models, allocation, and risk budgeting'],
].map(([id, title, weight, summary]) => ({ id, title, weight, summary }));

const level3Topics = [
  ['ethics', 'Ethics & Professional Standards', '10-15%', 'portfolio-manager judgment, conflicts, suitability, and professional conduct cases'],
  ['asset-allocation', 'Asset Allocation', '15-20%', 'capital market expectations, strategic allocation, and rebalancing policy'],
  ['portfolio-construction', 'Portfolio Construction', '10-15%', 'risk budgets, active risk, manager selection, and portfolio design'],
  ['wealth-planning', 'Private Wealth Management', '10-15%', 'IPS construction, taxes, concentrated wealth, and behavioral constraints'],
  ['institutional-ips', 'Institutional Portfolio Management', '10-15%', 'pension, endowment, foundation, insurance, and bank objectives'],
  ['fixed-income-pm', 'Fixed Income Portfolio Management', '10-15%', 'duration targeting, curve strategy, credit, and liability matching'],
  ['equity-pm', 'Equity Portfolio Management', '5-10%', 'active equity process, factor tilts, and attribution'],
  ['derivatives-risk', 'Derivatives And Risk Management', '5-10%', 'overlay strategy, hedging, option-based protection, and risk control'],
  ['alternatives-pm', 'Alternative Investments In Portfolios', '5-10%', 'allocation roles, liquidity, fees, and appraisal risk'],
  ['performance', 'Performance Evaluation', '5-10%', 'return attribution, appraisal, manager monitoring, and reporting'],
].map(([id, title, weight, summary]) => ({ id, title, weight, summary }));

const objectiveThemes = [
  ['concepts', 'Explain core concepts and vocabulary'],
  ['calculations', 'Perform exam-style calculations'],
  ['interpretation', 'Interpret outputs and signals'],
  ['applications', 'Apply concepts to client or issuer cases'],
  ['risk', 'Identify risk, bias, and model limitations'],
  ['valuation', 'Connect assumptions to valuation or allocation outcomes'],
  ['ethics', 'Recognize conduct, governance, and suitability traps'],
  ['integration', 'Integrate the topic with portfolio decisions'],
  ['review', 'Diagnose common answer-choice traps'],
  ['mock', 'Execute under timed mock-exam conditions'],
];

const toolCycle = [
  { toolId: 'calculator:tvm', toolType: 'calculator', path: '/calculators', title: 'TVM and valuation calculator' },
  { toolId: 'calculator:bond', toolType: 'calculator', path: '/calculators', title: 'Bond analytics calculator' },
  { toolId: 'quant:var-cvar', toolType: 'quant-lab', path: '/quant/risk-management', title: 'VaR/CVaR skill lab' },
  { toolId: 'quant:frontier', toolType: 'quant-lab', path: '/quant/portfolio-optimization', title: 'Efficient-frontier skill lab' },
  { toolId: 'excel:dcf', toolType: 'excel-drill', path: '/excel/dcf-modeling', title: 'DCF spreadsheet drill' },
  { toolId: 'excel:audit', toolType: 'excel-drill', path: '/excel/fundamentals', title: 'Model audit drill' },
  { toolId: 'formula:drill', toolType: 'formula-drill', path: '/flashcards', title: 'Formula flashcard drill' },
];

function topicKey(level, topic) {
  return level === 'level1' ? topic : `${level}:${topic}`;
}

function titleToWords(title) {
  return title
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

function generatedObjective(level, topic, topicTitle, index) {
  const [slug, label] = objectiveThemes[index % objectiveThemes.length];
  const id = `${level}-${topic}-${slug}`;
  return {
    id,
    domain: 'cfa',
    topic: topicKey(level, topic),
    title: `${label} in ${topicTitle}`,
    description: `Use original ${level.toUpperCase()} ${topicTitle} material to ${label.toLowerCase()} with exam-style precision.`,
    weight: level === 'level1' ? 'core' : level === 'level2' ? 'item-set' : 'constructed-response',
    tags: [level, topic, slug],
  };
}

function normalizeBaseObjective(level, topic, objective) {
  if (!objective) return null;
  return {
    ...objective,
    topic: topicKey(level, topic),
    tags: [...new Set([level, topic, ...(objective.tags || [])])],
  };
}

function buildObjectives(level, topic, title) {
  const base = level === 'level1' ? (cfaLearningObjectives[topic] || []).map((objective) => normalizeBaseObjective(level, topic, objective)) : [];
  const minimum = level === 'level1' ? 10 : 8;
  const generated = Array.from({ length: minimum }, (_, index) => generatedObjective(level, topic, title, index));
  const seen = new Set();
  return [...base, ...generated]
    .filter(Boolean)
    .filter((objective) => {
      if (seen.has(objective.id)) return false;
      seen.add(objective.id);
      return true;
    })
    .slice(0, minimum);
}

function buildSections(level, topic, title, summary, objectives) {
  const baseSections = level === 'level1' ? cfaContent[topic]?.sections || [] : [];
  const generated = objectives.flatMap((objective, index) => [
    {
      title: objective.title,
      content:
        `${title} requires a clean chain from concept to decision. This section frames ${objective.description} The exam skill is to isolate the relevant assumption, ignore distracting detail, and choose the answer that best fits the stated objective.`,
      keyPoints: [
        `Start with the ${titleToWords(title).toLowerCase()} concept being tested.`,
        'Separate data given in the stem from assumptions you are tempted to add.',
        'Convert the result into the language of the learning objective before selecting an answer.',
      ],
    },
    {
      title: `${title} exam trap ${index + 1}`,
      content:
        `A common trap in ${title} is solving the familiar problem instead of the problem asked. For ${objective.title.toLowerCase()}, verify timing, units, sign convention, client role, and whether the question asks for the most likely, least likely, or best action.`,
      keyPoints: [
        'Underline the command word before calculating.',
        'Treat answer choices as hypotheses to test, not prompts to rationalize.',
        'When two answers seem plausible, prefer the one that directly satisfies the stated constraint.',
      ],
    },
  ]);
  const combined = [...baseSections, ...generated];
  if (combined.length >= 12) return combined.slice(0, 18);
  return [
    ...combined,
    ...Array.from({ length: 12 - combined.length }, (_, index) => ({
      title: `${title} synthesis drill ${index + 1}`,
      content: `${summary} This synthesis drill connects definitions, calculations, interpretation, and exam pacing into one compact review loop.`,
      keyPoints: ['Define the variable or duty.', 'Apply the calculation or rule.', 'State the implication for the decision.'],
    })),
  ];
}

function buildFormulas(level, topic, title) {
  const base = level === 'level1' ? cfaContent[topic]?.formulas || [] : [];
  const generated = Array.from({ length: 10 }, (_, index) => ({
    name: `${title} Key Concept ${index + 1}`,
    latex: `\\text{${titleToWords(title)}}_{${index + 1}} = \\text{Input} \\rightarrow \\text{Decision}`,
    description: `Exam-ready ${title} concept linking a provided input to the correct interpretation or action.`,
  }));
  const seen = new Set();
  return [...base, ...generated].filter((formula) => {
    if (seen.has(formula.name)) return false;
    seen.add(formula.name);
    return true;
  }).slice(0, 12);
}

function rotateOptions(options, correctIndex) {
  const shift = correctIndex % options.length;
  const rotated = [...options.slice(shift), ...options.slice(0, shift)];
  return { options: rotated, correct: rotated.indexOf(options[0]) };
}

function makeQuestion({ level, topic, title, objective, formula, index, itemType = 'single', prefix = 'q' }) {
  const difficulty = ['foundation', 'intermediate', 'advanced'][index % 3];
  const correct = `Focus on ${objective.title.toLowerCase()} using only facts supplied in the stem.`;
  const options = rotateOptions(
    [
      correct,
      `Choose the answer with the highest numeric value, regardless of context.`,
      `Ignore the stated constraint because ${title} rules are usually qualitative.`,
      `Defer the decision until every unrelated topic has been reviewed.`,
    ],
    index,
  );
  return {
    id: `${level}-${topic}-${prefix}-${index + 1}`,
    level,
    topic: topicKey(level, topic),
    learningObjective: objective.id,
    itemType,
    question: `${level.toUpperCase()} ${title} ${prefix} item ${index + 1}: which response best matches ${objective.title.toLowerCase()} in this exam scenario?`,
    options: options.options,
    correct: options.correct,
    explanation:
      `${objective.title} is tested by matching the rule, calculation, or judgment to the exact facts in the stem. The correct choice stays inside the prompt and avoids unrelated assumptions.`,
    difficulty,
    formula: index % 4 === 0 ? formula?.name : undefined,
    tags: [level, topic, itemType, difficulty, ...objective.tags.slice(0, 2)],
    errorCategories: ['concept', 'calculation', 'formula', 'misread', 'time-pressure', 'none'],
    answerRationale: {
      correct: `The correct choice directly applies ${objective.title.toLowerCase()} to the facts supplied.`,
      distractors: [
        'Uses numeric magnitude without checking the command word.',
        'Adds an unstated exception or qualitative override.',
        'Avoids the decision instead of answering the prompt.',
      ],
      examTrap: 'The item is designed to punish familiar-but-adjacent reasoning.',
    },
  };
}

function normalizeBaseQuestion(level, topic, question) {
  return {
    ...question,
    id: `${level}-${question.id}`,
    level,
    topic: topicKey(level, topic),
    itemType: question.itemType || 'single',
    tags: [...new Set([level, topic, ...(question.tags || [])])],
    errorCategories: question.errorCategories || ['concept', 'calculation', 'formula', 'misread', 'none'],
  };
}

function buildQuestions(level, topic, title, objectives, formulas) {
  const base = level === 'level1' ? (cfaQuizzes[topic] || []).map((question, index) => normalizeBaseQuestion(level, topic, question, index)) : [];
  const target = level === 'level1' ? 80 : level === 'level2' ? 36 : 24;
  const generated = Array.from({ length: target }, (_, index) =>
    makeQuestion({
      level,
      topic,
      title,
      objective: objectives[index % objectives.length],
      formula: formulas[index % formulas.length],
      index,
    }),
  );
  const seen = new Set();
  return [...base, ...generated].filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  }).slice(0, target);
}

function buildExamples(level, topic, title, objectives, formulas) {
  return objectives.slice(0, 8).map((objective, index) => ({
    id: `${level}-${topic}-example-${index + 1}`,
    topic: topicKey(level, topic),
    learningObjective: objective.id,
    title: `${title} worked example ${index + 1}`,
    prompt: `A candidate must apply ${objective.title.toLowerCase()} with limited time and one distracting data point.`,
    walkthrough:
      `Step 1: identify the command word. Step 2: map the given facts to ${objective.title}. Step 3: use ${formulas[index % formulas.length]?.name || 'the relevant concept'} only if it directly supports the decision.`,
    formulaName: formulas[index % formulas.length]?.name,
    tags: [level, topic, 'worked-example'],
  }));
}

function buildVignettes(level, topic, title, objectives, formulas) {
  const target = level === 'level2' ? 12 : level === 'level3' ? 6 : 6;
  return Array.from({ length: target }, (_, index) => {
    const objectiveSlice = [objectives[index % objectives.length], objectives[(index + 1) % objectives.length]];
    return {
      id: `${level}-${topic}-vignette-${index + 1}`,
      level,
      topic: topicKey(level, topic),
      title: `${title} case set ${index + 1}`,
      stem:
        `A local exam-style case describes a ${title.toLowerCase()} decision with multiple exhibits, one irrelevant assumption, and one calculation cue. The candidate must connect the facts to the stated objective rather than overfit the distractor.`,
      exhibits: [
        {
          id: `${level}-${topic}-vignette-${index + 1}-facts`,
          title: 'Candidate facts',
          type: 'facts',
          content: `${title} case facts include timing, constraint, and decision-use details mapped to ${objectiveSlice[0].title}.`,
          sourceObjectiveIds: objectiveSlice.map((objective) => objective.id),
        },
        {
          id: `${level}-${topic}-vignette-${index + 1}-calculation`,
          title: 'Calculation cue',
          type: 'calculation',
          content: `${formulas[index % formulas.length]?.name || title} is relevant only if the question asks for the linked interpretation.`,
          sourceObjectiveIds: [objectiveSlice[0].id],
        },
      ],
      difficulty: ['foundation', 'intermediate', 'advanced'][index % 3],
      learningObjectives: objectiveSlice.map((objective) => objective.id),
      tags: [level, topic, 'vignette'],
      questions: Array.from({ length: 3 }, (_, qIndex) =>
        makeQuestion({
          level,
          topic,
          title,
          objective: objectiveSlice[qIndex % objectiveSlice.length],
          formula: formulas[(index + qIndex) % formulas.length],
          index: index * 3 + qIndex,
          itemType: 'vignette',
          prefix: `vig-${index + 1}`,
        }),
      ),
    };
  });
}

function buildRubric(level, topic, title, index) {
  return {
    id: `${level}-${topic}-rubric-${index + 1}`,
    title: `${title} response rubric ${index + 1}`,
    maxPoints: 6,
    criteria: [
      { id: 'identify', label: 'Identify', points: 2, description: 'Names the relevant objective, constraint, or client need.' },
      { id: 'apply', label: 'Apply', points: 2, description: 'Applies the rule, formula, or portfolio logic to the facts provided.' },
      { id: 'justify', label: 'Justify', points: 2, description: 'Explains the implication in concise exam language.' },
    ],
  };
}

function buildConstructedResponses(level, topic, title, objectives) {
  if (level !== 'level3') return [];
  return Array.from({ length: 4 }, (_, index) => ({
    id: `${level}-${topic}-cr-${index + 1}`,
    level,
    topic: topicKey(level, topic),
    title: `${title} constructed response ${index + 1}`,
    prompt:
      `Respond in bullet form. Address ${objectives[index % objectives.length].title.toLowerCase()} for a client or portfolio committee, state the decision, and justify it using only the case facts.`,
    commandWords: ['determine', 'justify', 'recommend'],
    learningObjectives: [objectives[index % objectives.length].id, objectives[(index + 1) % objectives.length].id],
    modelAnswer:
      `A full-credit response identifies the controlling objective, applies the relevant constraint or calculation, and gives a concise justification tied directly to the case facts.`,
    rubric: buildRubric(level, topic, title, index),
    tags: [level, topic, 'constructed-response'],
    difficulty: ['foundation', 'intermediate', 'advanced'][index % 3],
  }));
}

function buildFlashcards(level, topic, title, objectives, formulas) {
  const objectiveCards = objectives.flatMap((objective, index) => [
    ['definition', objective.title, objective.description],
    ['definition', `${objective.title} trap`, `Avoid adding unstated assumptions when applying ${objective.title.toLowerCase()}.`],
    ['definition', `${objective.title} command word`, `Translate the command word into the action required before reading answer choices.`],
    ['definition', `${objective.title} time check`, `If the item is calculation-heavy, write the formula and units before touching answer choices.`],
    ['error-pattern', `${objective.title} error pattern`, `Common miss: solving a familiar adjacent problem instead of the stated ${title} objective.`],
    ['definition', `${objective.title} review cue`, `Review this when confidence is high but accuracy is lagging.`],
    ['definition', `${objective.title} mock cue`, `In mocks, flag this objective when the stem has multiple constraints.`],
    ['definition', `${objective.title} lab cue`, `Use the mapped skill lab to turn the objective into an active drill.`],
  ].map(([type, front, back], cardIndex) => ({
    id: `${level}-${topic}-obj-card-${index + 1}-${cardIndex + 1}`,
    domain: 'cfa',
    topic: topicKey(level, topic),
    type,
    front,
    back,
    sourcePath: `/cfa/${level}/${topic}`,
    tags: [level, topic, 'objective'],
  })));

  const formulaCards = formulas.map((formula, index) => ({
    id: `${level}-${topic}-formula-card-${index + 1}`,
    domain: 'cfa',
    topic: topicKey(level, topic),
    type: 'formula',
    front: formula.name,
    back: `${formula.latex}\n\n${formula.description}`,
    sourcePath: `/cfa/${level}/${topic}`,
    tags: [level, topic, 'formula'],
  }));

  return [...objectiveCards, ...formulaCards];
}

function buildSkillLabs(level, topic, title, objectives) {
  return objectives.slice(0, 4).map((objective, index) => {
    const template = toolCycle[(index + title.length) % toolCycle.length];
    return {
      id: `${level}-${topic}-lab-${index + 1}`,
      title: `${title} ${template.title}`,
      domain: 'cfa',
      topic: topicKey(level, topic),
      type: template.toolType,
      path: template.path,
      objectiveIds: [objective.id],
      artifactType: template.toolType === 'excel-drill' ? 'excel-grid' : template.toolType === 'quant-lab' ? 'quant-lab' : 'calculator',
      description: `Exam skill lab for ${objective.title.toLowerCase()}.`,
    };
  });
}

function buildToolMappings(skillLabs) {
  return skillLabs.flatMap((lab) =>
    lab.objectiveIds.map((objectiveId) => ({
      objectiveId,
      toolId: lab.id,
      toolType: lab.type,
      path: lab.path,
      reason: lab.description,
    })),
  );
}

function buildTopic(level, topic) {
  const objectives = buildObjectives(level, topic.id, topic.title);
  const formulas = buildFormulas(level, topic.id, topic.title);
  const sections = buildSections(level, topic.id, topic.title, topic.summary, objectives);
  const questions = buildQuestions(level, topic.id, topic.title, objectives, formulas);
  const examples = buildExamples(level, topic.id, topic.title, objectives, formulas);
  const vignettes = buildVignettes(level, topic.id, topic.title, objectives, formulas);
  const constructedResponses = buildConstructedResponses(level, topic.id, topic.title, objectives);
  const flashcards = buildFlashcards(level, topic.id, topic.title, objectives, formulas);
  const skillLabs = buildSkillLabs(level, topic.id, topic.title, objectives);

  return {
    id: topic.id,
    level,
    topic: topicKey(level, topic.id),
    title: topic.title,
    weight: topic.weight,
    maturity: topicMaturity(level, topic.id),
    runtimeMode: 'generated',
    runtimeLabel: 'Generated scaffold',
    readings: [
      {
        id: `${level}-${topic.id}-reading-1`,
        topic: topicKey(level, topic.id),
        title: `${topic.title} exam mastery reading`,
        sections,
        formulas,
        examples,
      },
    ],
    sections,
    examples,
    learningObjectives: objectives,
    formulas,
    questions,
    vignettes,
    constructedResponses,
    flashcards,
    skillLabs,
    toolMappings: buildToolMappings(skillLabs),
    sourceMeta: {
      original: true,
      curriculumMap: `${level}:${topic.id}`,
      authoringStatus: topicMaturity(level, topic.id),
      runtimeMode: 'generated',
      runtimeLabel: 'Generated scaffold',
    },
  };
}

function buildMockExams(level, topics) {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${level}-mixed-mock-${index + 1}`,
    level,
    title: `${level.replace('level', 'Level ')} Mixed Mock ${index + 1}`,
    durationMinutes: level === 'level1' ? 135 : level === 'level2' ? 132 : 132,
    topics: topics.map((topic) => topic.id),
    questionIds: topics.flatMap((topic) => topic.questions.slice(index * 2, index * 2 + 2).map((question) => question.id)),
    vignetteIds: topics.flatMap((topic) => topic.vignettes.slice(index, index + 1).map((vignette) => vignette.id)),
    constructedResponseIds:
      level === 'level3'
        ? topics.flatMap((topic) => topic.constructedResponses.slice(index % 2, (index % 2) + 1).map((item) => item.id))
        : [],
    itemTypes: level === 'level3' ? ['constructed-response', 'vignette'] : level === 'level2' ? ['vignette'] : ['single'],
  }));
}

function buildLevel(id, title, examFormat, summary, topicBlueprints) {
  const topics = topicBlueprints.map((topic) => buildTopic(id, topic));
  return {
    id,
    title,
    examFormat,
    summary,
    runtimeMode: 'generated',
    runtimeLabel: 'Generated scaffold',
    topics,
    mockExams: buildMockExams(id, topics),
    constructedResponses: topics.flatMap((topic) => topic.constructedResponses),
    sourceMeta: {
      original: true,
      curriculumMap: id,
      authoringStatus: levelMaturity[id],
      runtimeMode: 'generated',
      runtimeLabel: 'Generated scaffold',
    },
  };
}

const generatedLevel1 = buildLevel(
    'level1',
    'CFA Level I',
    'Standalone multiple-choice questions focused on knowledge and comprehension.',
    'The Level I bundle saturates the existing ten topics with deterministic local lessons, drills, vignettes, flashcards, and skill-lab mappings.',
    level1Topics,
  );

export const cfaLevelContent = [
  getLevel1AuthoredRuntimeMode() === 'generated' ? generatedLevel1 : buildRuntimeLevelFromPacks('level1'),
  buildLevel(
    'level2',
    'CFA Level II',
    'Item-set vignettes focused on application, analysis, valuation, and interpretation.',
    'The Level II bundle introduces deeper valuation and case-analysis practice while staying local and original.',
    level2Topics,
  ),
  buildLevel(
    'level3',
    'CFA Level III',
    'Constructed response and item-set cases focused on portfolio management judgment.',
    'The Level III bundle adds command-word drills, rubrics, IPS-style cases, and portfolio construction tools.',
    level3Topics,
  ),
];

export const cfaLevels = cfaLevelContent.map((level) => ({
  id: level.id,
  title: level.title,
  examFormat: level.examFormat,
  summary: level.summary,
  runtimeMode: level.runtimeMode || 'generated',
  runtimeLabel: level.runtimeLabel || 'Generated scaffold',
  topics: level.topics.map((topic) => ({
    id: topic.id,
    label: topic.title,
    weight: topic.weight,
    maturity: topic.maturity,
    runtimeMode: topic.runtimeMode || level.runtimeMode || 'generated',
    runtimeLabel: topic.runtimeLabel || level.runtimeLabel || 'Generated scaffold',
    questions: topic.questions.length,
    vignettes: topic.vignettes.length,
    flashcards: topic.flashcards.length,
    skillLabs: topic.skillLabs.length,
  })),
}));

export const cfaRuntimeReport = {
  generatedAt: new Date().toISOString(),
  levels: [
    getLevel1RuntimeStatus(),
    {
      level: 'level2',
      mode: 'generated',
      label: 'Generated scaffold',
      releaseEligible: false,
      topicCount: cfaLevelContent.find((level) => level.id === 'level2')?.topics.length || 0,
      authoredPackCount: 0,
      validatedTopics: 0,
      examReadyTopics: 0,
      blockers: ['Level II remains draft scaffold content until Level I editorial quality is proven.'],
      warnings: ['Level II runtime is generated draft content.'],
    },
    {
      level: 'level3',
      mode: 'generated',
      label: 'Generated scaffold',
      releaseEligible: false,
      topicCount: cfaLevelContent.find((level) => level.id === 'level3')?.topics.length || 0,
      authoredPackCount: 0,
      validatedTopics: 0,
      examReadyTopics: 0,
      blockers: ['Level III remains draft scaffold content until core and pathway taxonomy is reconciled.'],
      warnings: ['Level III runtime is generated draft content.'],
    },
  ],
};

export function getCfaRuntimeReport() {
  return cfaRuntimeReport;
}

export const cfaAllTopics = cfaLevelContent.flatMap((level) => level.topics);
export const cfaAllQuestions = cfaAllTopics.flatMap((topic) => [
  ...topic.questions,
  ...topic.vignettes.flatMap((vignette) => vignette.questions),
]);
export const cfaAllVignettes = cfaAllTopics.flatMap((topic) => topic.vignettes);
export const cfaAllFlashcards = cfaAllTopics.flatMap((topic) => topic.flashcards);
export const cfaAllSkillLabs = cfaAllTopics.flatMap((topic) => topic.skillLabs);
export const cfaAllConstructedResponses = cfaAllTopics.flatMap((topic) => topic.constructedResponses);

export function getCfaLevelContent(level = 'level1') {
  return cfaLevelContent.find((item) => item.id === level) || cfaLevelContent[0];
}

export function getCfaTopicContent(level = 'level1', topicId) {
  return getCfaLevelContent(level).topics.find((topic) => topic.id === topicId) || null;
}

export function getCfaQuestions({ level = 'level1', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.questions || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.questions);
}

export function getCfaVignettes({ level = 'level1', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.vignettes || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.vignettes);
}

export function getCfaConstructedResponses({ level = 'level3', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.constructedResponses || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.constructedResponses);
}

export function getCfaMockExam(level = 'level1', mockId) {
  const mocks = getCfaLevelContent(level).mockExams;
  return mocks.find((mock) => mock.id === mockId) || mocks[0];
}

export function getCfaTopicKey(level, topic) {
  return topicKey(level, topic);
}
