export const quantContent = {
  probability: {
    title: 'Probability & Statistics',
    level: 'Core',
    summary:
      'Turn distributions, sampling error, Bayesian updates, regression, and time-series behavior into practical finance intuition.',
    outcomes: [
      'Identify which distribution assumption matches a market problem',
      'Translate volatility and confidence levels into tail-risk estimates',
      'Use regression output without overreading noisy relationships',
      'Recognize stationarity, autocorrelation, and regime-change risks',
    ],
    sections: [
      {
        title: 'Distribution Thinking',
        content:
          'Most finance models begin with a distributional assumption. Normal models are tractable and useful for first-pass risk, but market returns often show skew, fat tails, clustering volatility, and jumps. The skill is not memorizing the bell curve; it is knowing when the bell curve is merely a local approximation.',
        keyPoints: [
          'Mean and volatility are not enough when tails are asymmetric',
          'Lognormal models are common for prices because prices cannot fall below zero',
          'Fat tails make extreme losses more common than normal models imply',
        ],
      },
      {
        title: 'Inference And Regression',
        content:
          'Regression is a tool for estimating conditional relationships, not a certificate of causality. In finance, the most common mistakes are using too little data, ignoring unstable coefficients, and treating in-sample fit as out-of-sample edge.',
        keyPoints: [
          'R-squared explains fit, not economic truth',
          'P-values are conditional on model assumptions',
          'Residual diagnostics matter as much as coefficients',
        ],
      },
      {
        title: 'Risk Workflow',
        content:
          'A probability workflow starts by choosing the loss variable, matching the distribution to the decision horizon, and stress-testing the assumption before reporting a single risk number.',
        keyPoints: [
          'Document the horizon, confidence level, and data window',
          'Compare parametric output with at least one scenario loss',
          'Escalate model risk when tails or regimes dominate the result',
        ],
      },
    ],
    formulas: [
      { name: 'Variance', latex: '\\sigma^2 = E[(X-\\mu)^2]', description: 'Expected squared distance from the mean' },
      { name: 'Bayes Formula', latex: 'P(A|B)=\\frac{P(B|A)P(A)}{P(B)}', description: 'Updates a prior probability after observing evidence' },
      { name: 'Normal VaR', latex: 'VaR_\\alpha = V(\\mu - z_\\alpha\\sigma)', description: 'Parametric value at risk under a normal assumption' },
    ],
    lab: 'risk-tail',
  },
  'linear-algebra': {
    title: 'Linear Algebra for Finance',
    level: 'Core',
    summary:
      'Use vectors, matrices, covariance, eigenvectors, and PCA as the language of portfolios, factors, and risk systems.',
    outcomes: [
      'Represent portfolio weights and exposures as vectors',
      'Use covariance matrices to compute total portfolio risk',
      'Interpret eigenvectors as independent risk directions',
      'Understand PCA as a compression technique for correlated markets',
    ],
    sections: [
      {
        title: 'Vectors And Exposures',
        content:
          'A portfolio is a vector of weights. A risk model is a matrix that explains how assets move together. Multiplication turns individual asset risk into total portfolio risk, and the same mechanics power factor models and hedging systems.',
        keyPoints: [
          'Weights must be aligned to the same asset order as returns',
          'A covariance matrix must be symmetric and positive semi-definite',
          'Factor exposure is matrix multiplication with economic meaning',
        ],
      },
      {
        title: 'Eigenvectors And PCA',
        content:
          'Principal component analysis rotates correlated variables into new independent directions ordered by explained variance. Yield curves, equity sectors, and macro factors can often be summarized by a few dominant components.',
        keyPoints: [
          'The first principal component often captures the broad market move',
          'Later components may be economically meaningful or just noise',
          'PCA is useful for compression, monitoring, and stress testing',
        ],
      },
      {
        title: 'Portfolio Matrix Checks',
        content:
          'Before a covariance matrix is used in an optimizer or risk report, confirm that asset ordering, units, symmetry, and diversification logic are correct. Matrix math is unforgiving when the labels drift.',
        keyPoints: [
          'Weights, returns, and covariance rows must share the same order',
          'Covariance matrices should be symmetric and positive semi-definite',
          'Explain risk contribution, not just total volatility',
        ],
      },
    ],
    formulas: [
      { name: 'Portfolio Variance', latex: '\\sigma_p^2 = w^T\\Sigma w', description: 'Portfolio risk from weights and covariance' },
      { name: 'Factor Return', latex: 'r = Xf + \\epsilon', description: 'Return explained by factor exposure plus residual' },
      { name: 'Correlation From Covariance', latex: '\\rho_{ij}=\\frac{\\Sigma_{ij}}{\\sigma_i\\sigma_j}', description: 'Standardizes covariance into correlation' },
    ],
    lab: 'portfolio-risk',
  },
  'stochastic-calc': {
    title: 'Stochastic Calculus',
    level: 'Advanced',
    summary:
      'Model random paths through Brownian motion, Ito processes, drift, diffusion, and martingale pricing logic.',
    outcomes: [
      'Separate deterministic drift from random diffusion',
      'Read a stochastic differential equation without intimidation',
      'Understand why Ito correction appears in nonlinear transformations',
      'Connect risk-neutral dynamics to derivative pricing',
    ],
    sections: [
      {
        title: 'Brownian Motion',
        content:
          'Brownian motion is the continuous-time limit of independent random shocks. It has zero expected increment, variance proportional to time, and paths that are continuous but nowhere smooth.',
        keyPoints: [
          'Variance grows with time, standard deviation grows with the square root of time',
          'Independent increments make Brownian motion analytically tractable',
          'Geometric Brownian motion keeps modeled prices positive',
        ],
      },
      {
        title: 'Ito Processes',
        content:
          'An Ito process combines drift and diffusion. When a nonlinear function is applied to a stochastic process, the second derivative matters because squared Brownian increments behave like elapsed time.',
        keyPoints: [
          'Ito correction is the source of the volatility term in Black-Scholes',
          'Risk-neutral pricing replaces expected return with the risk-free rate',
          'Simulation helps build intuition before formal derivations',
        ],
      },
      {
        title: 'Simulation Discipline',
        content:
          'Path simulations are useful only when the time step, random seed, drift convention, and volatility convention are explicit. The desk question is whether path behavior changes the decision.',
        keyPoints: [
          'Use annualized inputs consistently with the simulation time step',
          'Separate real-world drift from risk-neutral drift',
          'Summarize path dispersion, not just one illustrative path',
        ],
      },
    ],
    formulas: [
      { name: 'Geometric Brownian Motion', latex: 'dS_t = \\mu S_t dt + \\sigma S_t dW_t', description: 'Common price process with drift and volatility' },
      { name: 'Ito Lemma', latex: 'df = f_tdt + f_xdX + \\frac{1}{2}f_{xx}(dX)^2', description: 'Chain rule for stochastic processes' },
      { name: 'Risk-Neutral Drift', latex: 'dS_t = rS_tdt + \\sigma S_tdW_t^Q', description: 'Risk-neutral price process used for derivative valuation' },
    ],
    lab: 'brownian-path',
  },
  'derivatives-pricing': {
    title: 'Derivatives Pricing',
    level: 'Advanced',
    summary:
      'Price contingent claims by connecting payoff diagrams, arbitrage bounds, Black-Scholes inputs, Greeks, and volatility assumptions.',
    outcomes: [
      'Explain no-arbitrage intuition behind pricing',
      'Use Black-Scholes inputs and interpret Greeks',
      'Compare option payoff and option value',
      'Understand why volatility and time drive convexity',
    ],
    sections: [
      {
        title: 'No-Arbitrage Intuition',
        content:
          'Derivative pricing is built around replication. If a portfolio can reproduce the derivative payoff in every state, the derivative and the replicating portfolio must have the same price. Otherwise arbitrage pressure closes the gap.',
        keyPoints: [
          'Payoff is value at expiration; price is present value under risk-neutral dynamics',
          'Delta hedging links option value to the underlying asset',
          'Put-call parity is the simplest no-arbitrage relationship',
        ],
      },
      {
        title: 'Greeks',
        content:
          'Greeks summarize local sensitivity. Delta tracks price exposure, gamma tracks delta curvature, theta tracks time decay, and vega tracks volatility exposure. A desk manages Greeks because prices do not move one input at a time.',
        keyPoints: [
          'Long options are usually long gamma and long vega',
          'Theta is usually negative for long plain-vanilla options',
          'Greeks are local approximations, not global guarantees',
        ],
      },
      {
        title: 'Model Cross-Checks',
        content:
          'A pricing workflow compares model value, intrinsic value, payoff, and sensitivity. When those do not tell the same story, the issue is usually inputs, convention, or an overlooked optionality feature.',
        keyPoints: [
          'Check moneyness before interpreting price or delta',
          'Compare Black-Scholes output with payoff intuition',
          'Treat volatility as an assumption to test, not a fact to accept',
        ],
      },
    ],
    formulas: [
      { name: 'Black-Scholes Call', latex: 'C=S_0N(d_1)-Ke^{-rT}N(d_2)', description: 'European call option value' },
      { name: 'Put-Call Parity', latex: 'C + Ke^{-rT}=P+S_0', description: 'No-arbitrage relationship between calls and puts' },
      { name: 'Black-Scholes d1', latex: 'd_1=\\frac{\\ln(S_0/K)+(r+\\sigma^2/2)T}{\\sigma\\sqrt{T}}', description: 'Moneyness, carry, volatility, and time input to Black-Scholes' },
    ],
    lab: 'option-surface',
  },
  'risk-management': {
    title: 'Risk Management',
    level: 'Applied',
    summary:
      'Measure, stress, and communicate market risk with VaR, expected shortfall, scenario analysis, and risk-budget discipline.',
    outcomes: [
      'Distinguish VaR from expected shortfall',
      'Stress portfolios outside historical comfort zones',
      'Translate volatility and correlation into business risk',
      'Recognize model risk and procyclicality',
    ],
    sections: [
      {
        title: 'VaR And Expected Shortfall',
        content:
          'Value at Risk estimates a loss threshold at a confidence level. Expected shortfall estimates the average loss beyond that threshold. VaR is easy to communicate, but expected shortfall is usually better at describing tail severity.',
        keyPoints: [
          'VaR says little about how bad losses are past the threshold',
          'Expected shortfall is more tail-aware',
          'Both measures are only as good as the model and data behind them',
        ],
      },
      {
        title: 'Stress Testing',
        content:
          'Stress testing asks what happens when assumptions break. Historical scenarios, hypothetical macro shocks, and reverse stress tests complement statistical risk models by forcing explicit discussion of severe but plausible states.',
        keyPoints: [
          'Correlation often rises during crises',
          'Liquidity risk can dominate mark-to-market risk',
          'Reverse stress tests start with failure and work backward',
        ],
      },
      {
        title: 'Risk Communication',
        content:
          'Risk output should state what the number measures, what it excludes, and what decision it supports. VaR, expected shortfall, and stress loss belong together because each answers a different governance question.',
        keyPoints: [
          'Pair VaR with expected shortfall for tail severity',
          'Show stress loss beside statistical loss estimates',
          'Name the model limitations in the same view as the metric',
        ],
      },
    ],
    formulas: [
      { name: 'Parametric VaR', latex: 'VaR_\\alpha = V(\\mu - z_\\alpha\\sigma)', description: 'Normal model loss threshold' },
      { name: 'Expected Shortfall', latex: 'ES_\\alpha = E[L | L > VaR_\\alpha]', description: 'Average tail loss beyond VaR' },
      { name: 'Stress Loss', latex: '\\text{Stress loss}=V\\times\\text{Shock}', description: 'Scenario loss from a stated portfolio shock' },
    ],
    lab: 'stress-var',
  },
  'portfolio-optimization': {
    title: 'Portfolio Optimization',
    level: 'Applied',
    summary:
      'Build portfolios from expected returns, risk, constraints, factor exposures, and robust assumptions instead of pure spreadsheet fantasy.',
    outcomes: [
      'Compute portfolio return and variance',
      'Explain the efficient frontier',
      'Recognize optimizer sensitivity to expected-return inputs',
      'Use constraints and shrinkage to make portfolios more robust',
    ],
    sections: [
      {
        title: 'Mean-Variance Core',
        content:
          'Mean-variance optimization balances expected return against variance. In practice, the covariance estimate is often more stable than expected returns, so unconstrained optimizers can produce fragile allocations.',
        keyPoints: [
          'Small expected-return changes can create large weight changes',
          'Constraints make results more realistic',
          'Diversification depends on correlation, not just asset count',
        ],
      },
      {
        title: 'Robust Allocation',
        content:
          'Professional workflows add constraints, factor views, turnover budgets, stress tests, and scenario analysis. The goal is not the perfect optimal portfolio; it is a portfolio that survives estimation error.',
        keyPoints: [
          'Black-Litterman blends market equilibrium with investor views',
          'Risk parity allocates by risk contribution',
          'Transaction costs can erase theoretical improvements',
        ],
      },
      {
        title: 'Implementation Guardrails',
        content:
          'An optimized allocation still has to be tradable, explainable, and reviewable. Constraint design, turnover limits, and sensitivity checks turn a fragile efficient-frontier point into an investable recommendation.',
        keyPoints: [
          'Run sensitivity on expected returns before trusting weights',
          'Use constraints to encode liquidity, concentration, and turnover limits',
          'Translate optimizer output into risk-budget language',
        ],
      },
    ],
    formulas: [
      { name: 'Portfolio Return', latex: 'E[R_p] = w^T\\mu', description: 'Weighted expected return' },
      { name: 'Sharpe Ratio', latex: 'S = \\frac{R_p - R_f}{\\sigma_p}', description: 'Excess return per unit of total risk' },
      { name: 'Portfolio Variance', latex: '\\sigma_p^2=w^T\\Sigma w', description: 'Portfolio variance from weights and covariance matrix' },
    ],
    lab: 'efficient-frontier',
  },
};
