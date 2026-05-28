// CFA Level III Learning Outcome Statement (LOS) bank.
//
// L3 covers the "core" curriculum (Asset Allocation, Portfolio Construction,
// Performance Measurement, Derivatives & Risk, Ethics) plus three optional
// pathways (Portfolio Management, Private Markets, Private Wealth). The
// candidate elects ONE pathway, but the in-app registry tracks all three so
// the LOS bank covers all three too — picking the LOS that are pathway-core,
// not pathway-pathway-specific (so e.g. a portfolio manager candidate still
// gets representative content for the Private Wealth pathway pack).
//
// Topic IDs and titles must match `src/domains/cfa/level3Packs/topics.ts`.
//
// LOS phrasings are paraphrased from the publicly published L3 outcomes.

export default [
  {
    topic: 'ethics',
    title: 'Ethics & Professional Standards',
    learningOutcomes: [
      'Demonstrate the application of the Code of Ethics and Standards of Professional Conduct to portfolio-manager and adviser case scenarios',
      'Recommend practices and procedures designed to prevent violations of the Code and Standards in a portfolio-management context',
      'Evaluate conduct, policies, and disclosures relative to the Asset Manager Code of Professional Conduct',
      'Explain the responsibilities of an adviser to a private client, including suitability, fair dealing, and disclosure of conflicts',
      'Apply the Code and Standards to investment-recommendation, soft-dollar, trade-allocation, and performance-presentation scenarios',
      'Evaluate compliance with the GIPS standards for performance presentation, including composite construction and disclosure',
      'Distinguish between conduct that conforms to the Code and Standards and conduct that violates the Code and Standards in pathway-relevant cases',
    ],
  },
  {
    topic: 'asset-allocation',
    title: 'Asset Allocation',
    learningOutcomes: [
      'Describe the steps in the asset-allocation process, including the role of the investment policy statement (IPS)',
      'Compare asset-only, liability-relative, and goals-based approaches to strategic asset allocation',
      'Recommend and justify a strategic asset allocation that satisfies an investor\'s return, risk, and constraint objectives',
      'Describe risk budgeting and explain how it is implemented at the asset-class, factor, and active-management levels',
      'Explain the rebalancing process and recommend a rebalancing policy (calendar, percent-of-portfolio) that suits an investor',
      'Describe tactical asset allocation and evaluate the active risk and expected return of a tactical tilt',
      'Explain how short-term and long-term capital market expectations affect the asset-allocation decision',
      'Describe how taxes, liquidity needs, regulatory constraints, and unique circumstances modify the asset-allocation recommendation',
      'Evaluate the effect of currency exposure on a global portfolio and recommend a hedging policy',
    ],
  },
  {
    topic: 'portfolio-construction',
    title: 'Portfolio Construction',
    learningOutcomes: [
      'Describe the implementation choices available to a portfolio manager (active, passive, factor-based, smart-beta) and recommend an approach',
      'Evaluate manager skill, persistence, and alpha decay when constructing an active-manager lineup',
      'Calculate and interpret active risk, active share, and the information ratio for an active manager',
      'Explain the role of the fundamental law of active management in setting an information ratio target',
      'Describe portfolio implementation costs, including explicit and implicit transaction costs, and explain how they affect realized active return',
      'Recommend a portfolio implementation plan (cash equitization, derivatives overlay, sleeve structure) that is consistent with the policy allocation',
      'Evaluate the use of multi-manager portfolios and recommend a manager-selection and monitoring framework',
      'Determine an appropriate rebalancing and trading strategy that limits implementation shortfall',
    ],
  },
  {
    topic: 'performance',
    title: 'Performance Measurement',
    learningOutcomes: [
      'Describe attribution analysis and decompose portfolio active return into allocation and selection effects',
      'Calculate and interpret macro and micro attribution for an equity portfolio',
      'Distinguish between time-weighted and money-weighted rates of return and explain when each is appropriate',
      'Evaluate the appropriateness of a benchmark and describe the properties of a valid benchmark',
      'Describe risk-adjusted performance measures (Sharpe, Treynor, Jensen\'s alpha, information ratio) and apply them in manager appraisal',
      'Recommend monitoring actions based on attribution evidence and identify situations that justify a manager change',
      'Explain the GIPS standards as they apply to performance reporting and verification',
    ],
  },
  {
    topic: 'derivatives-risk',
    title: 'Derivatives And Risk Management',
    learningOutcomes: [
      'Describe and evaluate the use of futures, options, and swaps to modify portfolio exposures (equity, fixed income, currency)',
      'Calculate and interpret the number of contracts required to achieve a target duration, beta, or currency exposure',
      'Recommend and justify a hedging strategy using forwards or futures, considering basis risk and rolling costs',
      'Compare and evaluate option-based strategies (protective put, collar, covered call) for managing equity-market risk',
      'Describe currency-overlay strategies and recommend a hedge ratio for a global equity or fixed-income portfolio',
      'Explain the use of credit default swaps, total return swaps, and other credit derivatives to manage portfolio credit exposure',
      'Calculate and interpret value at risk (VaR), conditional VaR, and expected shortfall, and explain their use in setting risk limits',
      'Describe stress testing, scenario analysis, and back-testing, and recommend how they should be used to validate a risk model',
    ],
  },
  {
    topic: 'pm-pathway',
    title: 'Portfolio Management Pathway',
    learningOutcomes: [
      'Describe the active equity investment process, including idea generation, portfolio construction, and risk control',
      'Compare fundamental and quantitative active management approaches and evaluate the strengths and limitations of each',
      'Describe the role of a passive equity portfolio and recommend a tracking strategy (full replication, sampling, optimization)',
      'Construct a fixed-income portfolio that meets a stated duration, convexity, and credit-quality objective',
      'Describe immunization and duration matching for a single liability and for multiple liabilities',
      'Recommend an active fixed-income strategy (riding the yield curve, sector rotation, duration tilt) given a yield-curve view',
      'Evaluate trade-execution choices, including algorithmic trading, and recommend an execution approach consistent with portfolio objectives',
      'Describe the use of derivatives in equity and fixed-income portfolio management for exposure and risk control',
    ],
  },
  {
    topic: 'private-markets-pathway',
    title: 'Private Markets Pathway',
    learningOutcomes: [
      'Describe the structure of private equity, private credit, real estate, and infrastructure funds and explain the alignment between GP and LP',
      'Calculate and interpret private market performance measures (IRR, MOIC, DPI, RVPI, TVPI, PME)',
      'Explain the J-curve and recommend a commitment-pacing strategy for an LP building a private markets allocation',
      'Evaluate fund fees (management fee, carried interest, hurdle, catch-up, waterfall) and their effect on net-of-fee returns',
      'Describe valuation approaches for private market investments and explain why valuations are smoothed relative to public markets',
      'Recommend a private market allocation that is consistent with an investor\'s liquidity, regulatory, and return objectives',
      'Describe risk management for private market portfolios, including illiquidity, leverage, and concentration risk',
      'Evaluate exit alternatives (sale, IPO, secondary, recapitalization) and the factors that determine the exit choice',
    ],
  },
  {
    topic: 'private-wealth-pathway',
    title: 'Private Wealth Pathway',
    learningOutcomes: [
      'Describe the private wealth business model and the steps in the financial-planning process for an individual client',
      'Construct an investment policy statement for a private client that reflects return, risk, liquidity, time horizon, taxes, legal, and unique circumstances',
      'Describe behavioral biases and explain how they should be incorporated into the adviser–client relationship',
      'Evaluate the tax considerations relevant to a private client and recommend tax-aware investment, location, and harvesting strategies',
      'Describe estate-planning strategies (wills, trusts, gifts) and evaluate their effectiveness for a multi-generational family',
      'Recommend an approach to managing a concentrated single-stock position, considering tax, control, and diversification objectives',
      'Describe goals-based wealth management and calculate the funded ratio for a stated goal',
      'Evaluate insurance and risk-management products as components of a private-wealth plan',
    ],
  },
];
