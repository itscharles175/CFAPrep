import type {
  AssessmentBlueprint,
  ContentMaturity,
  CurriculumLevel,
  CurriculumMap,
  CurriculumSourceMeta,
  CurriculumSourceReference,
  CurriculumTopic,
  FlashcardBlueprint,
  FormulaBlueprint,
  ObjectiveBlueprint,
  SkillLabMapping,
  StudyUnit,
} from '../../lib/contentTypes';
import { contentPackToCurriculumTopic, getAuthoredContentPack } from './contentPacks';

export const DEFAULT_CFA_EXAM_YEAR = 2026;

const publicReferences: CurriculumSourceReference[] = [
  {
    title: 'CFA Program curriculum overview',
    url: 'https://www.cfainstitute.org/programs/cfa-program/curriculum',
    usage: 'topic-weights',
  },
  {
    title: 'CFA Level I exam guide',
    url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-i-exam',
    usage: 'exam-format',
  },
  {
    title: 'CFA Level III exam guide',
    url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-iii-exam',
    usage: 'exam-format',
  },
  {
    title: 'CFA exam information',
    url: 'https://www.cfainstitute.org/programs/cfa-program/exam',
    usage: 'public-structure',
  },
];

function sourceMeta(authoringStatus: ContentMaturity, notes = 'Original local authoring map aligned only to public CFA structure.'): CurriculumSourceMeta {
  return {
    original: true,
    examYear: DEFAULT_CFA_EXAM_YEAR,
    publicReferences,
    authoringStatus,
    notes,
  };
}

function draftObjectives(level: CurriculumLevel['id'], topicId: string, title: string, skill: ObjectiveBlueprint['skill']): ObjectiveBlueprint[] {
  return [
    {
      id: `${level}-${topicId}-map-obj-1`,
      title: `${title} foundation map`,
      description: `Build original ${title} vocabulary, relationships, and exam decision rules without copying official outcome wording.`,
      skill,
      tags: [level, topicId, 'foundation'],
      commandWords: level === 'level3' ? ['identify', 'recommend'] : undefined,
    },
    {
      id: `${level}-${topicId}-map-obj-2`,
      title: `${title} calculation and interpretation map`,
      description: `Connect calculations, case facts, and answer-choice interpretation for ${title} practice.`,
      skill,
      tags: [level, topicId, 'calculation', 'interpretation'],
      commandWords: level === 'level3' ? ['calculate', 'justify'] : undefined,
    },
    {
      id: `${level}-${topicId}-map-obj-3`,
      title: `${title} exam trap map`,
      description: `Document recurring traps, distractor logic, and review cues for original ${title} drills.`,
      skill,
      tags: [level, topicId, 'errors', 'review'],
      commandWords: level === 'level3' ? ['explain', 'determine'] : undefined,
    },
  ];
}

function draftFormulas(level: CurriculumLevel['id'], topicId: string, title: string, objectiveIds: string[]): FormulaBlueprint[] {
  return [
    {
      id: `${level}-${topicId}-formula-1`,
      name: `${title} Key Concept Bridge`,
      latex: '\\text{Input} \\rightarrow \\text{Decision}',
      description: `Placeholder concept bridge for authored ${title} formulas and decision rules.`,
      objectiveIds: objectiveIds.slice(0, 2),
    },
    {
      id: `${level}-${topicId}-formula-2`,
      name: `${title} Review Signal`,
      latex: '\\text{Signal} = \\text{Fact} - \\text{Distractor}',
      description: `Placeholder review signal that will be replaced by authored formulas or key concepts.`,
      objectiveIds: objectiveIds.slice(1, 3),
    },
  ];
}

function makeAssessmentBlueprint(
  id: string,
  itemType: AssessmentBlueprint['itemType'],
  scope: AssessmentBlueprint['scope'],
  count: number,
  objectiveIds: string[],
  notes: string,
): AssessmentBlueprint {
  return {
    id,
    itemType,
    scope,
    count,
    objectiveIds,
    difficultyMix: { foundation: 0.4, intermediate: 0.4, advanced: 0.2 },
    promptStyle: 'Original, exam-style prompt with one best answer or one clearly scored response.',
    notes,
    commandWords: itemType === 'constructed-response' ? ['determine', 'justify', 'recommend'] : undefined,
    rubricBands: itemType === 'constructed-response' ? ['identify', 'apply', 'justify'] : undefined,
  };
}

function makeFlashcardBlueprint(id: string, type: FlashcardBlueprint['type'], count: number, objectiveIds: string[], promptStyle: string): FlashcardBlueprint {
  return {
    id,
    type,
    count,
    objectiveIds,
    promptStyle,
  };
}

function draftTopic(
  level: CurriculumLevel['id'],
  seed: { id: string; title: string; weight: string; focus: string; pathway?: CurriculumTopic['pathway'] },
  skill: ObjectiveBlueprint['skill'],
  itemType: AssessmentBlueprint['itemType'],
  scope: AssessmentBlueprint['scope'],
): CurriculumTopic {
  const objectiveBlueprints = draftObjectives(level, seed.id, seed.title, skill);
  const objectiveIds = objectiveBlueprints.map((objective) => objective.id);
  const formulaBlueprints = draftFormulas(level, seed.id, seed.title, objectiveIds);
  const assessmentNotes =
    level === 'level1'
      ? 'Draft Level I standalone item specs; full authoring happens after the Fixed Income pilot pattern is accepted.'
      : level === 'level2'
        ? 'Draft Level II vignette/item-set specs; full item-set cases come after Level I pilot stabilization.'
        : 'Draft Level III response specs; full rubrics come after Portfolio Management pathway mapping.';

  return {
    id: seed.id,
    title: seed.title,
    examWeight: seed.weight,
    maturity: 'draft',
    pathway: seed.pathway,
    sourceMeta: sourceMeta('draft', `Draft skeleton for ${seed.title}: ${seed.focus}`),
    objectiveBlueprints,
    formulaBlueprints,
    studyUnits: [
      {
        id: `${level}-${seed.id}-unit-1`,
        title: `${seed.title} authoring skeleton`,
        sequence: 1,
        summary: seed.focus,
        objectiveIds,
        formulaIds: formulaBlueprints.map((formula) => formula.id),
        lessonSectionCount: 3,
        workedExampleCount: 2,
        assessmentBlueprints: [
          makeAssessmentBlueprint(`${level}-${seed.id}-assess-1`, itemType, scope, level === 'level1' ? 8 : 4, objectiveIds, assessmentNotes),
        ],
        flashcardBlueprints: [
          makeFlashcardBlueprint(`${level}-${seed.id}-flashcards-1`, 'definition', 8, objectiveIds, 'Definition, trap, and recall cards from authored local wording.'),
        ],
        commonErrors: ['Relying on memorized adjacent concepts instead of the current prompt.', 'Missing the command word or case constraint.'],
      },
    ],
    skillLabMappings: [
      {
        id: `${level}-${seed.id}-skill-lab-1`,
        objectiveIds: [objectiveIds[1]],
        toolId: level === 'level2' ? 'excel:case-model' : level === 'level3' ? 'mock:constructed-response' : 'formula:drill',
        toolType: level === 'level2' ? 'excel-drill' : level === 'level3' ? 'mock' : 'formula-drill',
        path: level === 'level2' ? '/excel/dcf-modeling' : level === 'level3' ? `/cfa/${level}/${seed.id}/constructed-response` : '/flashcards',
        reason: `Draft tool mapping for ${seed.title} so the topic remains schedulable before full authoring.`,
      },
    ],
  };
}

const fixedIncomeObjectiveBlueprints: ObjectiveBlueprint[] = [
  {
    id: 'level1-fixed-income-obj-01',
    title: 'Classify bond promises, seniority, and embedded terms',
    description: 'Separate issuer promise, collateral, priority, coupon type, maturity, and embedded option features before valuation.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'bond-features'],
  },
  {
    id: 'level1-fixed-income-obj-02',
    title: 'Map fixed-income cash-flow timing',
    description: 'Build the coupon, principal, accrued interest, and settlement timeline needed to value a plain bond cleanly.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'cash-flows'],
  },
  {
    id: 'level1-fixed-income-obj-03',
    title: 'Explain the inverse price-yield relationship',
    description: 'Describe why higher required yield lowers the present value of fixed cash flows and why the curve is convex.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'price-yield'],
  },
  {
    id: 'level1-fixed-income-obj-04',
    title: 'Distinguish premium, par, and discount mechanics',
    description: 'Connect coupon rate versus market yield to premium or discount pricing and pull-to-par intuition.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'premium-discount'],
  },
  {
    id: 'level1-fixed-income-obj-05',
    title: 'Compare yield measures for decision use',
    description: 'Choose the yield measure that fits the question, including current yield, yield to maturity, money market yield, and effective annual yield.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'yield-measures'],
  },
  {
    id: 'level1-fixed-income-obj-06',
    title: 'Use spot and forward rates in valuation intuition',
    description: 'Relate spot discounting and forward-rate logic to the term structure without overclaiming that forwards are forecasts.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'term-structure'],
  },
  {
    id: 'level1-fixed-income-obj-07',
    title: 'Estimate interest-rate sensitivity with duration',
    description: 'Use Macaulay, modified, and effective duration concepts to estimate first-order price sensitivity.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'duration'],
  },
  {
    id: 'level1-fixed-income-obj-08',
    title: 'Apply convexity to improve price-change estimates',
    description: 'Explain why convexity changes the duration-only estimate and when the adjustment matters most.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'convexity'],
  },
  {
    id: 'level1-fixed-income-obj-09',
    title: 'Interpret curve and spread risk scenarios',
    description: 'Identify how parallel shifts, twists, credit spread changes, and option-adjusted spreads affect bond values.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'curve-risk', 'spread-risk'],
  },
  {
    id: 'level1-fixed-income-obj-10',
    title: 'Diagnose credit risk and priority of claims',
    description: 'Connect default probability, loss severity, covenants, seniority, collateral, and ratings to credit spread compensation.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'credit-risk'],
  },
  {
    id: 'level1-fixed-income-obj-11',
    title: 'Explain securitized cash-flow and prepayment risk',
    description: 'Describe how pooled assets, tranching, credit enhancement, and borrower prepayment change investor risk.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'securitization'],
  },
  {
    id: 'level1-fixed-income-obj-12',
    title: 'Connect fixed income to portfolio objectives',
    description: 'Use income, capital preservation, liability matching, diversification, and risk control goals to frame fixed-income allocation decisions.',
    skill: 'learn-describe',
    tags: ['level1', 'fixed-income', 'portfolio-role'],
  },
];

const fixedIncomeFormulaBlueprints: FormulaBlueprint[] = [
  {
    id: 'level1-fixed-income-formula-01',
    name: 'Plain Bond Price',
    latex: 'P = \\sum_{t=1}^{n}\\frac{C}{(1+y)^t} + \\frac{FV}{(1+y)^n}',
    description: 'Present value of coupons plus principal using the required yield.',
    objectiveIds: ['level1-fixed-income-obj-02', 'level1-fixed-income-obj-03'],
  },
  {
    id: 'level1-fixed-income-formula-02',
    name: 'Clean And Dirty Price',
    latex: 'Dirty\\ Price = Clean\\ Price + Accrued\\ Interest',
    description: 'Settlement price includes accrued interest; quoted price usually excludes it.',
    objectiveIds: ['level1-fixed-income-obj-02', 'level1-fixed-income-obj-04'],
  },
  {
    id: 'level1-fixed-income-formula-03',
    name: 'Current Yield',
    latex: 'Current\\ Yield = \\frac{Annual\\ Coupon}{Bond\\ Price}',
    description: 'Coupon income divided by price, excluding reinvestment and capital gain or loss.',
    objectiveIds: ['level1-fixed-income-obj-05'],
  },
  {
    id: 'level1-fixed-income-formula-04',
    name: 'Effective Annual Yield',
    latex: 'EAY = (1 + Periodic\\ Rate)^m - 1',
    description: 'Annualized yield with compounding frequency reflected.',
    objectiveIds: ['level1-fixed-income-obj-05'],
  },
  {
    id: 'level1-fixed-income-formula-05',
    name: 'Spot-Rate Bond Value',
    latex: 'P = \\sum_{t=1}^{n}\\frac{CF_t}{(1+s_t)^t}',
    description: 'Each cash flow is discounted at its maturity-matched spot rate.',
    objectiveIds: ['level1-fixed-income-obj-06'],
  },
  {
    id: 'level1-fixed-income-formula-06',
    name: 'One-Period Forward Rate',
    latex: '1 + f_{a,b} = \\left(\\frac{(1+s_b)^b}{(1+s_a)^a}\\right)^{1/(b-a)}',
    description: 'Implied rate between two maturities from the spot curve.',
    objectiveIds: ['level1-fixed-income-obj-06'],
  },
  {
    id: 'level1-fixed-income-formula-07',
    name: 'Macaulay Duration',
    latex: 'D_{mac} = \\frac{\\sum t \\times PV(CF_t)}{P}',
    description: 'Present-value weighted average timing of bond cash flows.',
    objectiveIds: ['level1-fixed-income-obj-07'],
  },
  {
    id: 'level1-fixed-income-formula-08',
    name: 'Modified Duration',
    latex: 'D_{mod} = \\frac{D_{mac}}{1 + y/m}',
    description: 'Approximate percentage price sensitivity for a small yield change.',
    objectiveIds: ['level1-fixed-income-obj-07'],
  },
  {
    id: 'level1-fixed-income-formula-09',
    name: 'Duration Price Change',
    latex: '\\frac{\\Delta P}{P} \\approx -D_{mod}\\Delta y',
    description: 'First-order estimate of price change from a yield move.',
    objectiveIds: ['level1-fixed-income-obj-07', 'level1-fixed-income-obj-09'],
  },
  {
    id: 'level1-fixed-income-formula-10',
    name: 'Convexity Adjustment',
    latex: '\\frac{\\Delta P}{P} \\approx -D_{mod}\\Delta y + \\frac{1}{2}Convexity(\\Delta y)^2',
    description: 'Second-order price-change estimate that improves on duration alone.',
    objectiveIds: ['level1-fixed-income-obj-08'],
  },
  {
    id: 'level1-fixed-income-formula-11',
    name: 'Credit Spread',
    latex: 'Credit\\ Spread = Yield_{risky} - Yield_{benchmark}',
    description: 'Extra yield over a benchmark for credit and liquidity risk.',
    objectiveIds: ['level1-fixed-income-obj-09', 'level1-fixed-income-obj-10'],
  },
  {
    id: 'level1-fixed-income-formula-12',
    name: 'Expected Credit Loss',
    latex: 'Expected\\ Loss = PD \\times LGD \\times Exposure',
    description: 'Simple expected-loss framing for credit-risk intuition.',
    objectiveIds: ['level1-fixed-income-obj-10'],
  },
];

function fiAssessment(unitId: string, objectiveIds: string[], singleCount: number, vignetteCount: number): AssessmentBlueprint[] {
  const blueprints = [
    makeAssessmentBlueprint(
      `${unitId}-single-items`,
      'single',
      'standalone',
      singleCount,
      objectiveIds,
      'Standalone Level I items with three answer choices, one best answer, and original rationales for each distractor.',
    ),
    makeAssessmentBlueprint(
      `${unitId}-formula-drills`,
      'formula-drill',
      'drill',
      3,
      objectiveIds,
      'Short calculation drills that record confidence and error type before review scheduling.',
    ),
  ];

  if (vignetteCount > 0) {
    blueprints.push(
      makeAssessmentBlueprint(
        `${unitId}-mini-vignettes`,
        'vignette',
        'mini-vignette',
        vignetteCount,
        objectiveIds,
        'Compact Level I mini-cases for synthesis; final standalone item answers remain independently scorable.',
      ),
    );
  }

  return blueprints;
}

function fiFlashcards(unitId: string, objectiveIds: string[]): FlashcardBlueprint[] {
  return [
    makeFlashcardBlueprint(`${unitId}-definition-cards`, 'definition', 5, objectiveIds, 'Front asks for a decision rule; back gives original concise wording and a trap cue.'),
    makeFlashcardBlueprint(`${unitId}-formula-cards`, 'formula', 3, objectiveIds, 'Front gives the formula name or use case; back gives formula, inputs, and sign convention.'),
    makeFlashcardBlueprint(`${unitId}-error-cards`, 'error-pattern', 2, objectiveIds, 'Front shows a common wrong move; back explains how to avoid it under time pressure.'),
  ];
}

const fixedIncomeStudyUnits: StudyUnit[] = [
  {
    id: 'level1-fixed-income-unit-01',
    title: 'Bond Features And Cash-Flow Promises',
    sequence: 1,
    summary: 'Classify issuer promises, payment timing, coupon structures, seniority, collateral, covenants, and embedded terms before doing valuation work.',
    objectiveIds: ['level1-fixed-income-obj-01', 'level1-fixed-income-obj-02', 'level1-fixed-income-obj-12'],
    formulaIds: ['level1-fixed-income-formula-01', 'level1-fixed-income-formula-02'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-01', ['level1-fixed-income-obj-01', 'level1-fixed-income-obj-02', 'level1-fixed-income-obj-12'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-01', ['level1-fixed-income-obj-01', 'level1-fixed-income-obj-02', 'level1-fixed-income-obj-12']),
    commonErrors: ['Treating coupon rate as required return.', 'Ignoring accrued interest and settlement timing.'],
  },
  {
    id: 'level1-fixed-income-unit-02',
    title: 'Price-Yield Mechanics',
    sequence: 2,
    summary: 'Build the inverse price-yield intuition, explain premium and discount bonds, and connect pull-to-par to coupon versus yield.',
    objectiveIds: ['level1-fixed-income-obj-03', 'level1-fixed-income-obj-04', 'level1-fixed-income-obj-02'],
    formulaIds: ['level1-fixed-income-formula-01', 'level1-fixed-income-formula-02'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-02', ['level1-fixed-income-obj-03', 'level1-fixed-income-obj-04', 'level1-fixed-income-obj-02'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-02', ['level1-fixed-income-obj-03', 'level1-fixed-income-obj-04', 'level1-fixed-income-obj-02']),
    commonErrors: ['Reversing price and yield direction.', 'Assuming all premium bonds are overvalued.'],
  },
  {
    id: 'level1-fixed-income-unit-03',
    title: 'Yield Measures And Compounding',
    sequence: 3,
    summary: 'Compare current yield, yield to maturity, money market yield, bond-equivalent yield, and effective annual yield for the decision being asked.',
    objectiveIds: ['level1-fixed-income-obj-05', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-04'],
    formulaIds: ['level1-fixed-income-formula-03', 'level1-fixed-income-formula-04'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-03', ['level1-fixed-income-obj-05', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-04'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-03', ['level1-fixed-income-obj-05', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-04']),
    commonErrors: ['Using current yield as a total-return measure.', 'Mixing periodic, stated, and effective rates.'],
  },
  {
    id: 'level1-fixed-income-unit-04',
    title: 'Spot Rates, Forward Rates, And Term Structure',
    sequence: 4,
    summary: 'Use spot-rate discounting and forward-rate intuition to interpret curve information without treating implied forwards as guaranteed predictions.',
    objectiveIds: ['level1-fixed-income-obj-06', 'level1-fixed-income-obj-05', 'level1-fixed-income-obj-09'],
    formulaIds: ['level1-fixed-income-formula-05', 'level1-fixed-income-formula-06'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-04', ['level1-fixed-income-obj-06', 'level1-fixed-income-obj-05', 'level1-fixed-income-obj-09'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-04', ['level1-fixed-income-obj-06', 'level1-fixed-income-obj-05', 'level1-fixed-income-obj-09']),
    commonErrors: ['Discounting every cash flow at the same rate when spot rates are supplied.', 'Calling a forward rate a certain future spot rate.'],
  },
  {
    id: 'level1-fixed-income-unit-05',
    title: 'Duration And First-Order Rate Risk',
    sequence: 5,
    summary: 'Use Macaulay, modified, and effective duration to estimate price sensitivity and compare bonds under small yield changes.',
    objectiveIds: ['level1-fixed-income-obj-07', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-09'],
    formulaIds: ['level1-fixed-income-formula-07', 'level1-fixed-income-formula-08', 'level1-fixed-income-formula-09'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-05', ['level1-fixed-income-obj-07', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-09'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-05', ['level1-fixed-income-obj-07', 'level1-fixed-income-obj-03', 'level1-fixed-income-obj-09']),
    commonErrors: ['Dropping the negative sign on duration estimates.', 'Using Macaulay duration directly as percentage price sensitivity.'],
  },
  {
    id: 'level1-fixed-income-unit-06',
    title: 'Convexity And Large Yield Moves',
    sequence: 6,
    summary: 'Add convexity to duration estimates and explain why positive convexity makes price gains and losses asymmetric.',
    objectiveIds: ['level1-fixed-income-obj-08', 'level1-fixed-income-obj-07', 'level1-fixed-income-obj-09'],
    formulaIds: ['level1-fixed-income-formula-09', 'level1-fixed-income-formula-10'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-06', ['level1-fixed-income-obj-08', 'level1-fixed-income-obj-07', 'level1-fixed-income-obj-09'], 10, 1),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-06', ['level1-fixed-income-obj-08', 'level1-fixed-income-obj-07', 'level1-fixed-income-obj-09']),
    commonErrors: ['Applying convexity with the wrong decimal yield change.', 'Forgetting that convexity adjustment is positive for plain option-free bonds.'],
  },
  {
    id: 'level1-fixed-income-unit-07',
    title: 'Curve, Spread, And Credit Risk',
    sequence: 7,
    summary: 'Interpret benchmark movement, spread movement, default probability, loss severity, covenants, priority, and collateral in credit decisions.',
    objectiveIds: ['level1-fixed-income-obj-09', 'level1-fixed-income-obj-10', 'level1-fixed-income-obj-01'],
    formulaIds: ['level1-fixed-income-formula-11', 'level1-fixed-income-formula-12'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-07', ['level1-fixed-income-obj-09', 'level1-fixed-income-obj-10', 'level1-fixed-income-obj-01'], 10, 0),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-07', ['level1-fixed-income-obj-09', 'level1-fixed-income-obj-10', 'level1-fixed-income-obj-01']),
    commonErrors: ['Blaming all yield changes on credit risk.', 'Confusing seniority with collateral quality.'],
  },
  {
    id: 'level1-fixed-income-unit-08',
    title: 'Securitization And Portfolio Use Cases',
    sequence: 8,
    summary: 'Explain pooled cash flows, tranching, prepayment risk, and the role of fixed income in income, liability matching, and diversification goals.',
    objectiveIds: ['level1-fixed-income-obj-11', 'level1-fixed-income-obj-12', 'level1-fixed-income-obj-10'],
    formulaIds: ['level1-fixed-income-formula-11', 'level1-fixed-income-formula-12'],
    lessonSectionCount: 2,
    workedExampleCount: 2,
    assessmentBlueprints: fiAssessment('level1-fixed-income-unit-08', ['level1-fixed-income-obj-11', 'level1-fixed-income-obj-12', 'level1-fixed-income-obj-10'], 10, 0),
    flashcardBlueprints: fiFlashcards('level1-fixed-income-unit-08', ['level1-fixed-income-obj-11', 'level1-fixed-income-obj-12', 'level1-fixed-income-obj-10']),
    commonErrors: ['Treating securitization as risk elimination.', 'Ignoring prepayment and extension risk in mortgage-backed structures.'],
  },
];

const fixedIncomeSkillLabMappings: SkillLabMapping[] = [
  {
    id: 'level1-fixed-income-skill-lab-01',
    objectiveIds: ['level1-fixed-income-obj-02', 'level1-fixed-income-obj-03'],
    toolId: 'calculator:bond-price',
    toolType: 'calculator',
    path: '/calculators',
    reason: 'Bond price and cash-flow timing drills turn valuation formulas into repeatable local practice.',
  },
  {
    id: 'level1-fixed-income-skill-lab-02',
    objectiveIds: ['level1-fixed-income-obj-05'],
    toolId: 'calculator:yield-measures',
    toolType: 'calculator',
    path: '/calculators',
    reason: 'Yield comparison drills reinforce compounding and measure selection.',
  },
  {
    id: 'level1-fixed-income-skill-lab-03',
    objectiveIds: ['level1-fixed-income-obj-07', 'level1-fixed-income-obj-08'],
    toolId: 'calculator:duration-convexity',
    toolType: 'calculator',
    path: '/calculators',
    reason: 'Duration and convexity calculations feed review scheduling after confidence-rated drills.',
  },
  {
    id: 'level1-fixed-income-skill-lab-04',
    objectiveIds: ['level1-fixed-income-obj-09'],
    toolId: 'quant:duration-shock',
    toolType: 'quant-lab',
    path: '/quant/risk-management',
    reason: 'Curve and spread shocks convert static formulas into scenario interpretation practice.',
  },
  {
    id: 'level1-fixed-income-skill-lab-05',
    objectiveIds: ['level1-fixed-income-obj-10'],
    toolId: 'calculator:credit-spread',
    toolType: 'calculator',
    path: '/calculators',
    reason: 'Credit spread examples connect risk factors to required compensation.',
  },
  {
    id: 'level1-fixed-income-skill-lab-06',
    objectiveIds: ['level1-fixed-income-obj-12'],
    toolId: 'quant:portfolio-risk',
    toolType: 'quant-lab',
    path: '/quant/portfolio-optimization',
    reason: 'Portfolio risk labs show how fixed income supports diversification and liability-aware decisions.',
  },
];

const level1TopicSeeds = [
  { id: 'ethics', title: 'Ethics & Professional Standards', weight: '15-20%', focus: 'duties, conflicts, integrity, professional conduct, and decision frameworks' },
  { id: 'quant-methods', title: 'Quantitative Methods', weight: '6-9%', focus: 'time value, statistics, probability, sampling, and regression foundations' },
  { id: 'economics', title: 'Economics', weight: '6-9%', focus: 'micro foundations, macro indicators, currency, trade, and business-cycle reasoning' },
  { id: 'fsa', title: 'Financial Statement Analysis', weight: '11-14%', focus: 'statement links, ratio analysis, inventories, long-lived assets, taxes, and reporting quality' },
  { id: 'corporate', title: 'Corporate Issuers', weight: '6-9%', focus: 'capital budgeting, cost of capital, leverage, working capital, and governance' },
  { id: 'equity', title: 'Equity Investments', weight: '11-14%', focus: 'market structure, industry analysis, company analysis, dividends, and relative valuation' },
  { id: 'fixed-income', title: 'Fixed Income', weight: '11-14%', focus: 'bond features, valuation, yield, duration, convexity, credit, securitization, and portfolio roles' },
  { id: 'derivatives', title: 'Derivatives', weight: '5-8%', focus: 'forwards, futures, swaps, options, no-arbitrage, payoffs, and hedging intuition' },
  { id: 'alternatives', title: 'Alternative Investments', weight: '7-10%', focus: 'real estate, private markets, hedge funds, commodities, fees, liquidity, and risk' },
  { id: 'portfolio', title: 'Portfolio Management', weight: '8-12%', focus: 'risk-return, diversification, CAPM, allocation, IPS, benchmarks, and performance basics' },
];

const level2TopicSeeds = [
  { id: 'ethics', title: 'Ethics & Professional Standards', weight: '10-15%', focus: 'case-based professional judgment, duties, conflicts, and conduct analysis' },
  { id: 'quant-methods', title: 'Quantitative Methods', weight: '5-10%', focus: 'regression, time series, model diagnostics, and machine-learning interpretation' },
  { id: 'economics', title: 'Economics', weight: '5-10%', focus: 'currency, growth, regulation, and macro scenario analysis in item sets' },
  { id: 'fsa', title: 'Financial Statement Analysis', weight: '10-15%', focus: 'intercorporate investments, pensions, multinational operations, and quality adjustments' },
  { id: 'corporate', title: 'Corporate Issuers', weight: '5-10%', focus: 'capital structure, governance, payout, and investment decision item sets' },
  { id: 'equity', title: 'Equity Valuation', weight: '10-15%', focus: 'DCF, residual income, private company valuation, and multiples in cases' },
  { id: 'fixed-income', title: 'Fixed Income', weight: '10-15%', focus: 'term structure, credit, embedded options, structured products, and valuation interpretation' },
  { id: 'derivatives', title: 'Derivatives', weight: '5-10%', focus: 'option valuation, swaps, forwards, futures, and risk-neutral case reasoning' },
  { id: 'alternatives', title: 'Alternative Investments', weight: '5-10%', focus: 'private equity, real estate, commodities, hedge funds, and valuation cases' },
  { id: 'portfolio', title: 'Portfolio Management And Wealth Planning', weight: '10-15%', focus: 'factor models, active management, risk budgeting, and wealth planning cases' },
];

const level3TopicSeeds = [
  { id: 'ethics', title: 'Ethics & Professional Standards', weight: '10-15%', focus: 'portfolio-manager conduct, conflicts, suitability, and professional judgment', pathway: 'core' as const },
  { id: 'asset-allocation', title: 'Asset Allocation', weight: '15-20%', focus: 'capital market expectations, strategic allocation, tactical allocation, and rebalancing', pathway: 'core' as const },
  { id: 'portfolio-construction', title: 'Portfolio Construction', weight: '15-20%', focus: 'risk budgets, implementation choices, manager selection, and portfolio design', pathway: 'core' as const },
  { id: 'performance', title: 'Performance Measurement', weight: '5-10%', focus: 'benchmark quality, attribution, appraisal, and manager monitoring', pathway: 'core' as const },
  { id: 'derivatives-risk', title: 'Derivatives And Risk Management', weight: '10-15%', focus: 'overlay strategies, option structures, currency risk, and hedge evaluation', pathway: 'core' as const },
  { id: 'pm-pathway', title: 'Portfolio Management Pathway', weight: '30-35%', focus: 'active equity, fixed-income strategy, index design, risk budgeting, and portfolio implementation', pathway: 'portfolio-management' as const },
];

function buildLevel1Topics(): CurriculumTopic[] {
  return level1TopicSeeds.map((seed) => {
    const authoredPack = getAuthoredContentPack('level1', seed.id);
    if (authoredPack) return contentPackToCurriculumTopic(authoredPack);
    if (seed.id !== 'fixed-income') return draftTopic('level1', seed, 'learn-describe', 'single', 'standalone');

    return {
      id: seed.id,
      title: seed.title,
      examWeight: seed.weight,
      maturity: 'exam-ready',
      sourceMeta: sourceMeta(
        'exam-ready',
        'Exam-ready pilot topic. Public sources are used only for topic weight and Level I standalone-item format; all objective, lesson, question, vignette, flashcard, and tool-map wording is original.',
      ),
      objectiveBlueprints: fixedIncomeObjectiveBlueprints,
      formulaBlueprints: fixedIncomeFormulaBlueprints,
      studyUnits: fixedIncomeStudyUnits,
      skillLabMappings: fixedIncomeSkillLabMappings,
    };
  });
}

function buildLevel2Topics(): CurriculumTopic[] {
  return level2TopicSeeds.map((seed) => {
    const authoredPack = getAuthoredContentPack('level2', seed.id);
    if (authoredPack) return contentPackToCurriculumTopic(authoredPack);
    return draftTopic('level2', seed, 'analyze-evaluate', 'vignette', 'item-set');
  });
}

function buildLevel3Topics(): CurriculumTopic[] {
  return level3TopicSeeds.map((seed) => {
    const authoredPack = getAuthoredContentPack('level3', seed.id);
    if (authoredPack) return contentPackToCurriculumTopic(authoredPack);
    return draftTopic('level3', seed, 'integrate-apply', 'constructed-response', 'constructed-response-set');
  });
}

export const cfaCurriculumMap = {
  id: 'cfa-curriculum-map-2026',
  examYear: DEFAULT_CFA_EXAM_YEAR,
  title: 'QuantVault Original CFA Curriculum Map',
  sourceMeta: sourceMeta(
    'draft',
    'Canonical local curriculum map. Public CFA pages anchor level structure, exam format, and topic weights only; learner-facing content remains original.',
  ),
  levels: [
    {
      id: 'level1',
      title: 'CFA Level I',
      examFormat: 'Standalone multiple-choice mastery focused on knowledge, comprehension, calculations, and recognition of common traps.',
      examWeightNotes: 'Ten public topic areas with current 2026 weight ranges used for planning and study prioritization.',
      topics: buildLevel1Topics(),
    },
    {
      id: 'level2',
      title: 'CFA Level II',
      examFormat: 'Vignette-supported item-set practice focused on application, analysis, valuation, and interpretation.',
      examWeightNotes: 'Ten public topic areas retained for all-level continuity; item-set authoring comes after the Level I Fixed Income pilot.',
      topics: buildLevel2Topics(),
    },
    {
      id: 'level3',
      title: 'CFA Level III',
      examFormat: 'Constructed-response and item-set practice focused on integrating portfolio management decisions with case facts.',
      examWeightNotes: 'Six active Level III topics use an all-or-nothing authored gate before public exam-ready release.',
      topics: buildLevel3Topics(),
    },
  ],
} satisfies CurriculumMap;

export function getCurriculumMap(examYear = DEFAULT_CFA_EXAM_YEAR): CurriculumMap {
  if (examYear !== DEFAULT_CFA_EXAM_YEAR) return cfaCurriculumMap;
  return cfaCurriculumMap;
}

export function getCurriculumLevel(level = 'level1'): CurriculumLevel {
  return cfaCurriculumMap.levels.find((item) => item.id === level) || cfaCurriculumMap.levels[0];
}

export function getCurriculumTopic(level = 'level1', topicId?: string): CurriculumTopic | null {
  if (!topicId) return null;
  return getCurriculumLevel(level).topics.find((topic) => topic.id === topicId) || null;
}

export function getCurriculumTopics(level?: string): CurriculumTopic[] {
  if (level) return getCurriculumLevel(level).topics;
  return cfaCurriculumMap.levels.flatMap((item) => item.topics);
}

export function getExamReadyCurriculumTopics(level?: string): CurriculumTopic[] {
  return getCurriculumTopics(level).filter((topic) => topic.maturity === 'exam-ready');
}
