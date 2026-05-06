import { searchToolRoutes } from '../routes/routeManifest';

export const domains = [
  {
    id: 'cfa',
    title: 'CFA Program',
    subtitle: 'Chartered Financial Analyst - all 3 levels',
    description:
      'Master ethics, quantitative methods, economics, FSA, valuation, fixed income, derivatives, alternatives, and portfolio management.',
    path: '/cfa',
    color: '#D4A853',
    gradient: 'linear-gradient(135deg, #D4A853 0%, #B8860B 100%)',
    badge: 'GOLD STANDARD',
    stats: { modules: 10, questions: '500+', hours: '300+' },
  },
  {
    id: 'quant',
    title: 'Quant Finance',
    subtitle: 'Mathematical and computational finance',
    description:
      'Build intuition for probability, stochastic processes, pricing engines, risk, and portfolio construction through live labs.',
    path: '/quant',
    color: '#8B5CF6',
    gradient: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
    badge: 'ADVANCED',
    stats: { modules: 6, labs: 6, formulas: '80+' },
  },
  {
    id: 'excel',
    title: 'Excel Training',
    subtitle: 'Financial modeling and automation',
    description:
      'Practice spreadsheet workflows, formulas, financial functions, DCF modeling, audit controls, and VBA automation patterns.',
    path: '/excel',
    color: '#10B981',
    gradient: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
    badge: 'PRACTICAL',
    stats: { modules: 5, exercises: '100+', templates: 12 },
  },
];

export const cfaTopics = [
  { id: 'ethics', label: 'Ethics & Professional Standards', weight: '15-20%', color: '#D4A853', modules: 6, questions: 45, status: 'available' },
  { id: 'quant-methods', label: 'Quantitative Methods', weight: '6-9%', color: '#3B82F6', modules: 5, questions: 40, status: 'available' },
  { id: 'economics', label: 'Economics', weight: '6-9%', color: '#10B981', modules: 4, questions: 35, status: 'available' },
  { id: 'fsa', label: 'Financial Statement Analysis', weight: '11-14%', color: '#8B5CF6', modules: 6, questions: 50, status: 'available' },
  { id: 'corporate', label: 'Corporate Issuers', weight: '6-9%', color: '#F59E0B', modules: 3, questions: 30, status: 'available' },
  { id: 'equity', label: 'Equity Investments', weight: '11-14%', color: '#EF4444', modules: 5, questions: 45, status: 'available' },
  { id: 'fixed-income', label: 'Fixed Income', weight: '11-14%', color: '#06B6D4', modules: 5, questions: 50, status: 'available' },
  { id: 'derivatives', label: 'Derivatives', weight: '5-8%', color: '#EC4899', modules: 4, questions: 35, status: 'available' },
  { id: 'alternatives', label: 'Alternative Investments', weight: '7-10%', color: '#14B8A6', modules: 3, questions: 25, status: 'available' },
  { id: 'portfolio', label: 'Portfolio Management', weight: '8-12%', color: '#A855F7', modules: 4, questions: 40, status: 'available' },
];

export const quantModules = [
  { id: 'probability', label: 'Probability & Statistics', desc: 'Distributions, Bayesian inference, regression, and time series analysis', color: '#3B82F6', status: 'available' },
  { id: 'linear-algebra', label: 'Linear Algebra for Finance', desc: 'Matrix operations, eigenvalues, PCA, and covariance matrices', color: '#8B5CF6', status: 'available' },
  { id: 'stochastic-calc', label: 'Stochastic Calculus', desc: 'Brownian motion, Ito processes, SDEs, and martingales', color: '#EF4444', status: 'available' },
  { id: 'derivatives-pricing', label: 'Derivatives Pricing', desc: 'Black-Scholes, binomial intuition, Greeks, and volatility surfaces', color: '#10B981', status: 'available' },
  { id: 'risk-management', label: 'Risk Management', desc: 'VaR, CVaR, stress testing, copulas, and Monte Carlo simulation', color: '#F59E0B', status: 'available' },
  { id: 'portfolio-optimization', label: 'Portfolio Optimization', desc: 'Mean-variance, Black-Litterman, factor models, and efficient frontiers', color: '#06B6D4', status: 'available' },
];

export const excelModules = [
  { id: 'fundamentals', label: 'Excel Fundamentals', desc: 'Navigation, shortcuts, references, formatting, and model hygiene', color: '#10B981', status: 'available' },
  { id: 'advanced-formulas', label: 'Advanced Formulas', desc: 'XLOOKUP, INDEX/MATCH, SUMIFS, dynamic arrays, and robust lookups', color: '#3B82F6', status: 'available' },
  { id: 'financial-functions', label: 'Financial Functions', desc: 'NPV, IRR, XNPV, XIRR, PMT, depreciation, and date-aware cash flows', color: '#8B5CF6', status: 'available' },
  { id: 'dcf-modeling', label: 'DCF Modeling', desc: 'Revenue build, margins, WACC, terminal value, and sensitivity tables', color: '#D4A853', status: 'available' },
  { id: 'vba-macros', label: 'VBA & Macros', desc: 'Macro recording, procedures, loops, ranges, UDFs, and automation safety', color: '#EF4444', status: 'available' },
];

export const formulaLibrary = [
  { category: 'Time Value of Money', name: 'Future Value', latex: 'FV = PV \\times (1 + r)^n', desc: 'Compound a present value forward in time', path: '/calculators' },
  { category: 'Time Value of Money', name: 'Present Value', latex: 'PV = \\frac{FV}{(1 + r)^n}', desc: 'Discount a future value back to today', path: '/calculators' },
  { category: 'Time Value of Money', name: 'PV of Annuity', latex: 'PV = PMT \\times \\frac{1 - (1+r)^{-n}}{r}', desc: 'Present value of equal periodic payments', path: '/calculators' },
  { category: 'Time Value of Money', name: 'Perpetuity', latex: 'PV = \\frac{PMT}{r}', desc: 'Value of infinite equal payments', path: '/cfa/level1/quant-methods' },
  { category: 'Time Value of Money', name: 'EAR', latex: 'EAR = \\left(1 + \\frac{r_s}{m}\\right)^m - 1', desc: 'Effective annual rate from stated rate', path: '/cfa/level1/quant-methods' },
  { category: 'Statistics', name: 'Variance', latex: '\\sigma^2 = \\frac{\\sum(X_i - \\mu)^2}{N}', desc: 'Average squared deviation from mean', path: '/quant/probability' },
  { category: 'Statistics', name: 'Sharpe Ratio', latex: 'S_p = \\frac{R_p - R_f}{\\sigma_p}', desc: 'Risk-adjusted return per unit of total risk', path: '/quant/portfolio-optimization' },
  { category: 'Statistics', name: 'Coefficient of Variation', latex: 'CV = \\frac{\\sigma}{\\bar{X}}', desc: 'Relative dispersion measure', path: '/quant/probability' },
  { category: 'Statistics', name: 'Bayes Formula', latex: 'P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}', desc: 'Update probability with new evidence', path: '/quant/probability' },
  { category: 'Statistics', name: 'Covariance', latex: 'Cov(X,Y) = E[(X-\\mu_X)(Y-\\mu_Y)]', desc: 'Measure of joint variability', path: '/quant/linear-algebra' },
  { category: 'Derivatives', name: 'Black-Scholes Call', latex: 'C = S_0 N(d_1) - K e^{-rT} N(d_2)', desc: 'European call option price', path: '/calculators' },
  { category: 'Derivatives', name: 'Black-Scholes d1', latex: 'd_1 = \\frac{\\ln(S/K) + (r + \\sigma^2/2)T}{\\sigma\\sqrt{T}}', desc: 'First parameter in Black-Scholes', path: '/quant/derivatives-pricing' },
  { category: 'Derivatives', name: 'Put-Call Parity', latex: 'C + Ke^{-rT} = P + S_0', desc: 'Relationship between call and put prices', path: '/quant/derivatives-pricing' },
  { category: 'Derivatives', name: 'Delta', latex: '\\Delta = \\frac{\\partial V}{\\partial S}', desc: 'Option value sensitivity to the underlying', path: '/quant/derivatives-pricing' },
  { category: 'Fixed Income', name: 'Bond Price', latex: 'P = \\sum_{t=1}^{n} \\frac{C}{(1+y)^t} + \\frac{FV}{(1+y)^n}', desc: 'Present value of coupon payments and face value', path: '/calculators' },
  { category: 'Fixed Income', name: 'Macaulay Duration', latex: 'D = \\frac{\\sum t \\cdot PV(CF_t)}{\\sum PV(CF_t)}', desc: 'Weighted average time to receive cash flows', path: '/calculators' },
  { category: 'Fixed Income', name: 'Modified Duration', latex: 'D_{mod} = \\frac{D_{mac}}{1 + y/m}', desc: 'Price sensitivity to yield changes', path: '/calculators' },
  { category: 'Portfolio', name: 'CAPM', latex: 'E(R_i) = R_f + \\beta_i [E(R_m) - R_f]', desc: 'Expected return based on systematic risk', path: '/quant/portfolio-optimization' },
  { category: 'Portfolio', name: 'Portfolio Variance', latex: '\\sigma_p^2 = w^T \\Sigma w', desc: 'Portfolio risk using weights and covariance matrix', path: '/quant/portfolio-optimization' },
  { category: 'Valuation', name: 'Gordon Growth Model', latex: 'P_0 = \\frac{D_1}{r - g}', desc: 'Stock price with constant dividend growth', path: '/excel/dcf-modeling' },
  { category: 'Valuation', name: 'WACC', latex: 'WACC = w_e r_e + w_d r_d (1 - T)', desc: 'Weighted average cost of capital', path: '/calculators' },
  { category: 'Valuation', name: 'Enterprise Value', latex: 'EV = Equity + Debt - Cash', desc: 'Total value of the business', path: '/excel/dcf-modeling' },
  { category: 'Risk', name: 'Parametric VaR', latex: 'VaR_\\alpha = V(\\mu - z_\\alpha \\sigma)', desc: 'Normal-distribution value at risk', path: '/quant/risk-management' },
  { category: 'Excel', name: 'XNPV', latex: 'XNPV = \\sum \\frac{CF_t}{(1+r)^{d_t/365}}', desc: 'Date-aware discounted cash flow in Excel', path: '/excel/financial-functions' },
];

export function buildSearchItems() {
  const domainItems = domains.map((domain) => ({
    id: `domain:${domain.id}`,
    title: domain.title,
    subtitle: domain.subtitle,
    type: 'Domain',
    path: domain.path,
    keywords: [domain.title, domain.subtitle, domain.description],
  }));

  const cfaItems = cfaTopics.map((topic) => ({
    id: `cfa:${topic.id}`,
    title: topic.label,
    subtitle: `CFA Level I - ${topic.weight}`,
    type: 'CFA',
    path: `/cfa/level1/${topic.id}`,
    disabled: topic.status !== 'available',
    keywords: [topic.label, topic.weight],
  }));

  const quantItems = quantModules.map((module) => ({
    id: `quant:${module.id}`,
    title: module.label,
    subtitle: module.desc,
    type: 'Quant',
    path: `/quant/${module.id}`,
    keywords: [module.label, module.desc],
  }));

  const excelItems = excelModules.map((module) => ({
    id: `excel:${module.id}`,
    title: module.label,
    subtitle: module.desc,
    type: 'Excel',
    path: `/excel/${module.id}`,
    keywords: [module.label, module.desc],
  }));

  const formulaItems = formulaLibrary.map((formula) => ({
    id: `formula:${formula.category}:${formula.name}`,
    title: formula.name,
    subtitle: `${formula.category} - ${formula.desc}`,
    type: 'Formula',
    path: formula.path || '/formulas',
    keywords: [formula.name, formula.category, formula.desc, formula.latex],
  }));

  return [...searchToolRoutes, ...domainItems, ...cfaItems, ...quantItems, ...excelItems, ...formulaItems];
}
