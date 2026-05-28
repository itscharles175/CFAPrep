// CFA Level II Learning Outcome Statement (LOS) bank.
//
// Pillar 10 (content breadth): we don't have L2 PDFs ingested into the
// .qvsource bundle yet, but the CFA Institute publishes the LOS for every
// topic. The LOS list is short, public, and authoritative: it tells the
// candidate exactly what they're expected to be able to do on exam day.
// That's enough for a local LLM to seed exam-realistic MCQs + flashcards
// per topic without any curriculum text — the LOS itself is the locator.
//
// Topic IDs and titles must match `src/domains/cfa/level2Packs/topics.ts`
// (the in-app L2 registry). The LOS bank is a flat array; each entry has:
//   topic              — canonical L2 topic id
//   title              — display title (mirrored from the topic registry)
//   learningOutcomes   — 6–12 short imperatives the LOS expects the
//                        candidate to be able to do. Phrased the way CFA
//                        Institute publishes them: action verb + scope.
//
// LOS phrasings are paraphrased — they capture the substance of the
// published CFA L2 outcomes without copying the curriculum copy verbatim.

export default [
  {
    topic: 'ethics',
    title: 'Ethics & Professional Standards',
    learningOutcomes: [
      'Demonstrate the application of the Code of Ethics and Standards of Professional Conduct to specific situations',
      'Recommend practices and procedures designed to prevent violations of the Code and Standards',
      'Evaluate practices, policies, and conduct relative to the CFA Institute Code and Standards',
      'Explain the ethical responsibilities required by the Code and Standards, including the multiple sub-sections of each Standard',
      'Distinguish between conduct that conforms to the Code and Standards and conduct that violates the Code and Standards',
      'Explain the GIPS standards for verification, performance presentation, and the structure of compliant composites',
      'Identify the requirements of the GIPS standards with respect to input data, calculation methodology, and disclosure',
      'Evaluate the professional conduct of a candidate or member in case-based item set scenarios',
    ],
  },
  {
    topic: 'quant-methods',
    title: 'Quantitative Methods',
    learningOutcomes: [
      'Formulate a multiple regression equation to describe the relation between a dependent variable and several independent variables',
      'Interpret estimated regression coefficients and their p-values and explain hypothesis tests on a single coefficient',
      'Calculate and interpret a predicted value for the dependent variable, given an estimated regression model and assumed values for the independent variables',
      'Explain the assumptions of a multiple regression model and how violations of those assumptions affect inference',
      'Explain serial correlation, heteroskedasticity, and multicollinearity, and describe how each is detected and corrected',
      'Describe how model misspecification affects the results of a regression analysis and how to avoid it',
      'Calculate and interpret a time-series model that includes trend, seasonality, and an autoregressive (AR) component',
      'Explain mean reversion and calculate a mean-reverting level for an AR(1) model',
      'Describe supervised and unsupervised machine-learning algorithms and how they are applied to financial data',
      'Describe the steps in a data analysis project (data preparation, model training, tuning, and out-of-sample testing)',
      'Evaluate the fit of a regression or classification model using R-squared, root mean squared error, and a confusion matrix',
    ],
  },
  {
    topic: 'economics',
    title: 'Economics',
    learningOutcomes: [
      'Calculate and interpret the bid-offer spread on a spot or forward currency quotation',
      'Explain mark-to-market value of, and credit risk in, a forward currency contract',
      'Describe international parity conditions (covered interest rate parity, uncovered interest rate parity, purchasing power parity, the international Fisher effect) and the relationships among them',
      'Describe relations among the impulse and propagation mechanisms that drive the business cycle, inflation, and exchange rates',
      'Describe how policy responses (monetary and fiscal) and capital flow regimes affect a currency',
      'Explain how international capital flows, savings, and investment affect long-term exchange rates',
      'Explain the determination of long-run real growth using a production-function framework, and describe the role of capital deepening and total factor productivity',
      'Explain the classifications of regulations and regulators and describe the economic rationale for regulatory intervention',
    ],
  },
  {
    topic: 'fsa',
    title: 'Financial Statement Analysis',
    learningOutcomes: [
      'Describe the classification, measurement, and disclosure under International Financial Reporting Standards and US Generally Accepted Accounting Principles for intercorporate investments in financial assets, associates, joint ventures, and business combinations',
      'Distinguish among the financial reporting impact of investments classified as financial assets, equity method investments, and consolidated subsidiaries',
      'Analyze how different methods used to account for intercorporate investments affect financial statements and ratios',
      'Describe the components of postemployment benefit costs and explain how pension and other postemployment benefits are reported in the financial statements',
      'Calculate and interpret the periodic pension cost and the impact of key actuarial assumptions on the reported pension obligation',
      'Distinguish between presentation currency, functional currency, and local currency and explain the translation of foreign subsidiary financial statements',
      'Calculate and interpret the effects on financial statements and ratios of the current rate method and the temporal method',
      'Evaluate the quality of a company\'s reported financial results and identify earnings-management indicators',
      'Adjust reported financial statements for off-balance-sheet financing, capitalization differences, and other comparability issues',
      'Describe the use of financial statement analysis in credit and equity analysis and integrate adjustments into ratio analysis',
    ],
  },
  {
    topic: 'corporate',
    title: 'Corporate Issuers',
    learningOutcomes: [
      'Describe and evaluate corporate governance and stakeholder management practices',
      'Describe the principal–agent and other relationships in corporate governance and identify potential conflicts of interest',
      'Explain capital budgeting and how the analysis of incremental cash flows affects investment decisions',
      'Calculate and interpret expanded NPV analysis including real options (timing, abandonment, expansion)',
      'Explain the theory and practice of capital structure choices, including the trade-off, pecking order, and Modigliani–Miller propositions',
      'Describe the influence of taxes, costs of financial distress, and asymmetric information on capital structure',
      'Describe the structural and reduced-form models of credit analysis and their applications to corporate issuers',
      'Calculate and interpret target capital structure ratios and weighted average cost of capital under different assumptions',
      'Describe corporate payout policy alternatives (dividends, buybacks) and the factors influencing payout choice',
      'Evaluate a company\'s dividend policy and share repurchase decisions and their effect on financial ratios and shareholder value',
    ],
  },
  {
    topic: 'equity',
    title: 'Equity Valuation',
    learningOutcomes: [
      'Calculate and interpret the value of a common stock using the dividend discount model (DDM) for one-period, multi-period, and infinite-period horizons',
      'Calculate and interpret the value of a stock using the free cash flow to equity (FCFE) and free cash flow to firm (FCFF) models',
      'Describe and apply the residual income model, including its key drivers and the persistence of residual income',
      'Calculate the intrinsic value using the Gordon growth model and the two-stage and H-model variants, and identify when each model is appropriate',
      'Explain the price multiples approach (P/E, P/B, P/S, EV/EBITDA) and calculate justified multiples based on fundamentals',
      'Describe the use of comparable-firm and comparable-transaction multiples, and identify the adjustments required to apply them',
      'Describe approaches to valuing private companies (income, market, asset-based) and apply discounts for lack of control and lack of marketability',
      'Evaluate the appropriateness of a chosen valuation model given the company\'s growth, profitability, and risk profile',
      'Calculate the cost of equity using the CAPM, the Fama–French model, and the build-up method',
      'Explain how scenario analysis and sensitivity analysis support equity valuation conclusions',
    ],
  },
  {
    topic: 'fixed-income',
    title: 'Fixed Income',
    learningOutcomes: [
      'Describe the term structure of interest rates and explain how the spot, forward, and par curves are related',
      'Calculate and interpret the value of a fixed-rate bond using spot rates and the no-arbitrage price',
      'Describe and calculate effective duration, key-rate duration, effective convexity, and explain how each measures price sensitivity',
      'Describe option-adjusted spread (OAS) and explain how it differs from nominal spread, Z-spread, and asset-swap spread',
      'Calculate the value of a callable or putable bond using a binomial interest rate tree and the option-adjusted price',
      'Describe credit risk and credit-related risks affecting corporate bonds, including default, downgrade, and credit spread risk',
      'Explain the structural and reduced-form models for credit analysis and calculate credit valuation adjustment (CVA)',
      'Describe asset-backed securities and the structure of mortgage-backed securities, collateralized mortgage obligations, and other securitized products',
      'Calculate and interpret prepayment risk, contraction risk, and extension risk on mortgage-backed securities',
      'Describe the term structure of credit spreads and explain how it can be used to evaluate relative value across issuers',
    ],
  },
  {
    topic: 'derivatives',
    title: 'Derivatives',
    learningOutcomes: [
      'Calculate the no-arbitrage price of a forward contract on a stock, an equity index, a bond, a currency, and an interest rate',
      'Describe how a forward rate agreement is priced and valued and calculate its value at any point in its life',
      'Explain the no-arbitrage value of a European option using put–call parity and put–call forward parity',
      'Calculate and interpret the value of a European option using a one- or two-period binomial model and the Black–Scholes–Merton model',
      'Describe how interest rate swaps, currency swaps, and equity swaps are priced and valued',
      'Calculate the value of a plain-vanilla interest rate swap as a series of forward rate agreements or as a pair of bonds',
      'Explain how option Greeks (delta, gamma, theta, vega, rho) are used to manage portfolio risk',
      'Describe the carry-arbitrage model and how the cost of carry affects forward and futures prices',
      'Explain the use of interest rate options and swaptions to manage interest rate risk',
      'Describe how credit default swaps are structured and priced and how they are used to hedge or to take credit exposure',
    ],
  },
  {
    topic: 'alternatives',
    title: 'Alternative Investments',
    learningOutcomes: [
      'Describe the characteristics, structure, and key features of private equity, real estate, infrastructure, commodities, and hedge fund investments',
      'Describe and compare the strategies, risks, and performance characteristics of private equity buyout, venture capital, and growth equity strategies',
      'Calculate and interpret private equity performance measures including IRR, MOIC, DPI, RVPI, and TVPI',
      'Explain the J-curve and the impact of fund fees, vintage year, and commitment pacing on limited partner returns',
      'Describe real estate valuation approaches (income, cost, sales comparison) and calculate the value of a property using the direct capitalization and discounted cash flow methods',
      'Describe and compare hedge fund strategies (equity hedge, event-driven, relative value, macro) and the role of leverage in their return profile',
      'Calculate and interpret risk-adjusted return measures for hedge funds and identify common biases in reported hedge fund performance',
      'Explain the diversification benefits, fees, and liquidity considerations of allocating to commodities and natural resources',
    ],
  },
  {
    topic: 'portfolio',
    title: 'Portfolio Management And Wealth Planning',
    learningOutcomes: [
      'Explain the steps in the portfolio management process and describe how each step links investor objectives to investment decisions',
      'Describe the implications of capital market expectations, risk objectives, and constraints in the construction of an investor\'s policy statement',
      'Calculate and interpret expected return, variance, and the Sharpe ratio of a portfolio of risky assets',
      'Explain factor models and the use of multifactor models in identifying sources of return and risk',
      'Describe the information ratio and explain how it is used to evaluate active portfolio management performance',
      'Calculate and interpret active return, active risk, and the fundamental law of active management',
      'Describe portfolio risk measures, including value at risk, expected shortfall, and stress testing, and explain their use in risk budgeting',
      'Explain the implementation of factor-based and risk-budgeted portfolios using futures, swaps, and other instruments',
      'Describe rebalancing approaches (calendar, percentage of portfolio) and the costs of rebalancing',
    ],
  },
];
