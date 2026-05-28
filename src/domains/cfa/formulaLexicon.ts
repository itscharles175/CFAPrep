export interface FormulaLexiconEntry {
  latex: string;
  description: string;
}

const exactFormulas: Record<string, FormulaLexiconEntry> = {
  'accounting equation': {
    latex: '\\text{Assets} = \\text{Liabilities} + \\text{Equity}',
    description: 'Balances resources, claims, and owner residual interest.',
  },
  'active return': {
    latex: 'R_A = R_p - R_b',
    description: 'Portfolio return in excess of the benchmark return.',
  },
  'active risk budget': {
    latex: '\\text{Risk use} = \\frac{\\sigma_A}{\\text{Active risk budget}}',
    description: 'Compares active risk used with the active risk limit.',
  },
  'active risk contribution': {
    latex: '\\text{ARC}_i = w_i(\\Sigma w)_i / \\sigma_p',
    description: 'Contribution of sleeve or manager i to total portfolio active risk.',
  },
  'agency cost': {
    latex: '\\text{Agency cost} = \\text{Monitoring cost} + \\text{Bonding cost} + \\text{Residual loss}',
    description: 'Summarizes costs that arise when managers and owners have different incentives.',
  },
  'adjusted leverage bridge': {
    latex: '\\text{Adjusted leverage} = \\frac{\\text{Debt} + \\text{off-balance-sheet debt}}{\\text{Equity}}',
    description: 'Restates leverage for financing obligations that are not obvious in reported debt.',
  },
  'after-tax liquidity need': {
    latex: '\\text{Gross sale required} = \\frac{\\text{After-tax cash need}}{1 - t}',
    description: 'Grosses up a liquidity need for taxes on the funding source.',
  },
  'allocation effect bridge': {
    latex: '\\text{Allocation effect}_i = (w_{p,i} - w_{b,i})(R_{b,i} - R_b)',
    description: 'Measures attribution from overweighting or underweighting benchmark segments.',
  },
  'allocation fairness test': {
    latex: '\\text{Fair allocation ratio}_i = \\frac{\\text{Allocation}_i}{\\text{Eligible order}_i}',
    description: 'Checks whether eligible clients receive fair allocation of limited investment opportunities.',
  },
  'appraisal lag signal': {
    latex: '\\rho_{reported,true} < 1 \\Rightarrow \\sigma_{reported} < \\sigma_{true}',
    description: 'Flags smoothed private-asset returns when appraisals lag market moves.',
  },
  'appraisal smoothing': {
    latex: 'R_{smoothed,t} = \\lambda R_t + (1 - \\lambda)R_{smoothed,t-1}',
    description: 'Models how appraisal-based returns dampen observed volatility.',
  },
  'arithmetic mean': {
    latex: '\\bar{R} = \\frac{1}{n}\\sum_{t=1}^{n}R_t',
    description: 'Average return across equally weighted observations.',
  },
  'asset turnover': {
    latex: '\\text{Asset turnover} = \\frac{\\text{Revenue}}{\\text{Average total assets}}',
    description: 'Measures revenue generated per unit of assets.',
  },
  'benchmark fit screen': {
    latex: '\\text{Fit score} = \\sum_i |w_{p,i} - w_{b,i}|',
    description: 'Checks whether a benchmark reasonably represents the managed portfolio.',
  },
  beta: {
    latex: '\\beta_i = \\frac{\\operatorname{Cov}(R_i,R_m)}{\\sigma_m^2}',
    description: 'Sensitivity of an asset return to market return.',
  },
  'book value per share': {
    latex: 'BVPS = \\frac{\\text{Common equity}}{\\text{Shares outstanding}}',
    description: 'Common equity allocated to each share.',
  },
  'call option payoff': {
    latex: '\\text{Call payoff} = \\max(S_T - X, 0)',
    description: 'Expiration payoff for a long call option.',
  },
  'capital asset pricing model': {
    latex: 'E(R_i) = R_f + \\beta_i[E(R_m)-R_f]',
    description: 'Required return based on systematic risk exposure.',
  },
  'capital market assumption check': {
    latex: '\\text{Assumption gap} = \\text{Forecast return} - \\text{Equilibrium return}',
    description: 'Tests whether capital-market assumptions are plausible relative to equilibrium anchors.',
  },
  'capitalization rate': {
    latex: '\\text{Cap rate} = \\frac{NOI}{\\text{Property value}}',
    description: 'Income yield used to value income-producing property.',
  },
  'carried interest': {
    latex: '\\text{Carried interest} = c\\times\\max(\\text{Profit} - \\text{Hurdle}, 0)',
    description: 'Performance fee paid after profits exceed the contractual hurdle.',
  },
  'cash conversion cycle': {
    latex: 'CCC = DIO + DSO - DPO',
    description: 'Days cash is tied up in the operating cycle.',
  },
  'cash-flow timing screen': {
    latex: '\\text{Timing effect} = \\sum_t CF_t\\left(\\frac{1}{(1+r)^{t_{actual}}} - \\frac{1}{(1+r)^{t_{expected}}}\\right)',
    description: 'Measures how actual cash-flow timing changes present value versus expectation.',
  },
  'clean and dirty price': {
    latex: '\\text{Dirty price} = \\text{Clean price} + \\text{Accrued interest}',
    description: 'Connects quoted bond price to invoice price.',
  },
  'client-first decision check': {
    latex: '\\text{Priority} = \\text{Client interest} > \\text{Employer interest} > \\text{Personal interest}',
    description: 'Ranks interests when fiduciary duty and conflicts are tested.',
  },
  'commodity roll yield': {
    latex: '\\text{Roll yield} \\approx \\frac{F_{near} - F_{far}}{F_{far}}',
    description: 'Return contribution from rolling futures exposure along the curve.',
  },
  'commitment pacing bridge': {
    latex: '\\text{New commitments} = \\text{Target NAV} + \\text{Distributions} - \\text{Current NAV}',
    description: 'Links target private-market exposure to annual commitment pacing.',
  },
  'concentrated position risk bridge': {
    latex: '\\text{Single-name exposure} = \\frac{\\text{Position value}}{\\text{Total investable assets}}',
    description: 'Measures concentration before tax, liquidity, and behavioral constraints.',
  },
  'confidence interval': {
    latex: '\\bar{x} \\pm z_{\\alpha/2}\\frac{s}{\\sqrt{n}}',
    description: 'Range estimate around a sample mean.',
  },
  'constraint-aware allocation': {
    latex: 'w_i^{final} = \\min(\\max(w_i^{target}, w_i^{min}), w_i^{max})',
    description: 'Constrains target allocation within policy minimum and maximum weights.',
  },
  'conflict disclosure sufficiency': {
    latex: '\\text{Disclosure sufficiency} = \\text{Existence} + \\text{Nature} + \\text{Potential impact}',
    description: 'Checks that a conflict disclosure gives enough information to judge the conflict.',
  },
  'conflicts disclosure': {
    latex: '\\text{Disclosure quality} = \\text{Complete} \\cap \\text{Plain} \\cap \\text{Timely}',
    description: 'Screens whether conflict disclosure is complete, understandable, and timely.',
  },
  convexity: {
    latex: '\\frac{\\Delta P}{P} \\approx -D_{mod}\\Delta y + \\frac{1}{2}C(\\Delta y)^2',
    description: 'Adds curvature to duration-based bond price estimates.',
  },
  'convexity adjustment': {
    latex: '\\frac{\\Delta P}{P} \\approx -D_{mod}\\Delta y + \\frac{1}{2}C(\\Delta y)^2',
    description: 'Adjusts duration price change for yield-curve curvature.',
  },
  correlation: {
    latex: '\\rho_{X,Y} = \\frac{\\operatorname{Cov}(X,Y)}{\\sigma_X\\sigma_Y}',
    description: 'Standardized measure of co-movement.',
  },
  covariance: {
    latex: '\\operatorname{Cov}(X,Y) = E[(X-\\mu_X)(Y-\\mu_Y)]',
    description: 'Joint variability between two returns or variables.',
  },
  'credit spread': {
    latex: '\\text{Credit spread} = y_{credit} - y_{risk-free}',
    description: 'Yield compensation over a comparable risk-free bond.',
  },
  'cross-price elasticity': {
    latex: 'E_{xy} = \\frac{\\%\\Delta Q_x}{\\%\\Delta P_y}',
    description: 'Demand sensitivity for one good to a price change in another good.',
  },
  'currency overlay exposure': {
    latex: '\\text{Net FX exposure} = \\text{Asset FX exposure} - \\text{Hedge notional}',
    description: 'Measures residual currency exposure after overlay hedges.',
  },
  'currency quote direction': {
    latex: '\\text{Base currency units} = \\text{Quote currency units} / S_{base/quote}',
    description: 'Keeps base and price currency interpretation consistent.',
  },
  'currency translation effect': {
    latex: '\\text{Translation effect} \\approx \\Delta FX \\times \\text{Net asset exposure}',
    description: 'Estimates reporting impact from exchange-rate movement.',
  },
  'current ratio': {
    latex: '\\text{Current ratio} = \\frac{\\text{Current assets}}{\\text{Current liabilities}}',
    description: 'Measures short-term liquidity using current balance-sheet accounts.',
  },
  'current yield': {
    latex: '\\text{Current yield} = \\frac{\\text{Annual coupon}}{\\text{Bond price}}',
    description: 'Coupon income relative to market price.',
  },
  'cost of debt': {
    latex: 'r_d(1-T) = \\text{Yield to maturity}\\times(1-T)',
    description: 'After-tax debt cost used in capital budgeting and WACC.',
  },
  'cost of equity': {
    latex: 'r_e = R_f + \\beta[E(R_m)-R_f]',
    description: 'Required return on equity estimated with CAPM.',
  },
  'debt to equity': {
    latex: '\\text{Debt-to-equity} = \\frac{\\text{Total debt}}{\\text{Total equity}}',
    description: 'Measures financial leverage from debt relative to equity.',
  },
  delta: {
    latex: '\\Delta = \\frac{\\partial V}{\\partial S}',
    description: 'Option value sensitivity to the underlying price.',
  },
  'derivative notional alignment': {
    latex: '\\text{Hedge notional} = \\text{Exposure value}\\times h',
    description: 'Checks that derivative notional matches the intended exposure and hedge ratio.',
  },
  'discounted cash flow value': {
    latex: 'V_0 = \\sum_{t=1}^{N}\\frac{CF_t}{(1+r)^t} + \\frac{TV_N}{(1+r)^N}',
    description: 'Present value of forecast cash flows and terminal value.',
  },
  'dividend payout ratio': {
    latex: '\\text{Payout ratio} = \\frac{\\text{Dividends}}{\\text{Net income}}',
    description: 'Share of earnings distributed as dividends.',
  },
  'dividend yield': {
    latex: '\\text{Dividend yield} = \\frac{D_1}{P_0}',
    description: 'Expected dividend relative to current price.',
  },
  'du pont roe': {
    latex: 'ROE = \\frac{NI}{Sales}\\times\\frac{Sales}{Assets}\\times\\frac{Assets}{Equity}',
    description: 'Decomposes ROE into margin, turnover, and leverage.',
  },
  'dupont roe': {
    latex: 'ROE = \\frac{NI}{Sales}\\times\\frac{Sales}{Assets}\\times\\frac{Assets}{Equity}',
    description: 'Decomposes ROE into margin, turnover, and leverage.',
  },
  'duration price change': {
    latex: '\\frac{\\Delta P}{P} \\approx -D_{mod}\\Delta y',
    description: 'Approximates bond price sensitivity to a yield change.',
  },
  'duties to clients': {
    latex: '\\text{Client duty score} = \\text{Loyalty} + \\text{Prudence} + \\text{Care}',
    description: 'Summarizes client-duty checks in an ethics scenario.',
  },
  'duties to employers': {
    latex: '\\text{Employer duty} = \\text{Loyalty} - \\text{Conflicting outside benefit}',
    description: 'Screens employer loyalty while preserving duties owed to clients and markets.',
  },
  'effective annual rate': {
    latex: 'EAR = \\left(1 + \\frac{r_s}{m}\\right)^m - 1',
    description: 'Converts a stated rate with compounding into an annual effective rate.',
  },
  'effective annual yield': {
    latex: 'EAY = (1 + HPY)^{365/t} - 1',
    description: 'Annualizes a holding-period yield using actual holding period.',
  },
  'enterprise value': {
    latex: 'EV = \\text{Market value of equity} + \\text{Debt} - \\text{Cash}',
    description: 'Measures total operating value available to capital providers.',
  },
  'enterprise value multiple': {
    latex: '\\frac{EV}{EBITDA} = \\frac{\\text{Enterprise value}}{\\text{EBITDA}}',
    description: 'Compares total business value with operating cash earnings proxy.',
  },
  'ethics case decision tree': {
    latex: '\\text{Action allowed} = \\text{Duty satisfied} \\cap \\neg\\text{Prohibited conduct}',
    description: 'Turns an ethics case into a duty check, prohibition check, and permitted action.',
  },
  'estate transfer sufficiency': {
    latex: '\\text{Transfer gap} = \\text{Target transfer} - \\text{After-tax transferable assets}',
    description: 'Tests whether estate-transfer resources meet stated family objectives.',
  },
  'expected credit loss': {
    latex: 'ECL = PD \\times LGD \\times EAD',
    description: 'Expected loss from default probability, loss severity, and exposure.',
  },
  'expected portfolio return': {
    latex: 'E(R_p) = \\sum_i w_iE(R_i)',
    description: 'Weighted average expected return of portfolio holdings.',
  },
  'expected portfolio risk bridge': {
    latex: '\\sigma_p = \\sqrt{w^T\\Sigma w}',
    description: 'Links weights and covariance to total expected portfolio risk.',
  },
  'expected value': {
    latex: 'E(X) = \\sum_i p_i x_i',
    description: 'Probability-weighted average outcome.',
  },
  'exchange-rate quote': {
    latex: '\\text{Domestic value} = \\text{Foreign amount}\\times S_{d/f}',
    description: 'Converts a foreign amount using the quoted domestic-per-foreign exchange rate.',
  },
  'exit multiple sensitivity': {
    latex: '\\Delta V \\approx EBITDA_{exit} \\times \\Delta \\text{Exit multiple}',
    description: 'Shows how exit multiple changes affect private-market valuation.',
  },
  'factor exposure check': {
    latex: '\\text{Portfolio exposure} = \\sum_i w_i\\beta_i',
    description: 'Aggregates security or manager factor exposures to portfolio level.',
  },
  'fair dealing allocation check': {
    latex: '\\text{Allocation fairness} = \\frac{\\text{Client allocation}}{\\text{Eligible client need}}',
    description: 'Checks whether similar clients receive fair access to investment actions.',
  },
  'fair dealing': {
    latex: '\\text{Fairness} = \\text{Same information} + \\text{Reasonable access}',
    description: 'Evaluates whether similarly situated clients are treated fairly.',
  },
  'fair presentation screen': {
    latex: '\\text{Presentation quality} = \\text{Complete} \\cap \\text{Accurate} \\cap \\text{Comparable}',
    description: 'Screens performance or recommendation presentation for fairness and clarity.',
  },
  'family governance decision path': {
    latex: '\\text{Governance fit} = \\text{Decision rights} + \\text{Communication cadence} + \\text{Conflict process}',
    description: 'Maps family-office governance facts to a recommended decision process.',
  },
  'fee-adjusted active return': {
    latex: 'R_{active,net} = R_p - R_b - \\text{Fees}',
    description: 'Measures active return after investment management fees.',
  },
  'financial leverage': {
    latex: 'DFL = \\frac{\\%\\Delta EPS}{\\%\\Delta EBIT}',
    description: 'Sensitivity of earnings per share to operating income changes.',
  },
  'fixed-income duration target': {
    latex: '\\Delta D = D_{target} - D_{portfolio}',
    description: 'Measures duration adjustment needed to reach a target duration.',
  },
  'forward payoff': {
    latex: '\\text{Long forward payoff} = S_T - F_0',
    description: 'Expiration payoff for a long forward contract.',
  },
  'forward rate': {
    latex: '1 + f_{1,1} = \\frac{(1+s_2)^2}{1+s_1}',
    description: 'One-period forward rate implied by spot rates.',
  },
  'forward value bridge': {
    latex: 'V_t = S_t - \\frac{F_0}{(1+r)^{T-t}}',
    description: 'Marks a forward contract to market before expiration.',
  },
  'future value': {
    latex: 'FV = PV(1+r)^N',
    description: 'Compounds a present value forward over N periods.',
  },
  'free cash flow yield': {
    latex: '\\text{FCF yield} = \\frac{FCF}{\\text{Market capitalization}}',
    description: 'Free cash flow relative to equity market value.',
  },
  'futures margin balance': {
    latex: '\\text{Margin balance}_t = \\text{Initial margin} + \\sum \\text{Daily gains/losses}',
    description: 'Tracks futures gains and losses through daily settlement.',
  },
  'gamma': {
    latex: '\\Gamma = \\frac{\\partial^2 V}{\\partial S^2}',
    description: 'Sensitivity of option delta to the underlying price.',
  },
  'geometric mean': {
    latex: 'R_G = \\left(\\prod_{t=1}^{n}(1+R_t)\\right)^{1/n} - 1',
    description: 'Compound average return across periods.',
  },
  'gdp identity': {
    latex: 'GDP = C + I + G + (X - M)',
    description: 'Expenditure approach to gross domestic product.',
  },
  'goals-based funded ratio': {
    latex: '\\text{Funded ratio} = \\frac{\\text{Assets allocated to goal}}{PV(\\text{Goal liability})}',
    description: 'Compares assets assigned to a goal with the present value of that goal.',
  },
  'gordon growth value': {
    latex: 'V_0 = \\frac{D_1}{r - g}',
    description: 'Value of a stock with dividends growing at a constant rate.',
  },
  'governance risk screen': {
    latex: '\\text{Governance risk} = \\text{Misalignment} + \\text{Control weakness} + \\text{Disclosure gap}',
    description: 'Summarizes governance issues that can affect corporate value.',
  },
  'gross margin': {
    latex: '\\text{Gross margin} = \\frac{\\text{Revenue} - \\text{COGS}}{\\text{Revenue}}',
    description: 'Measures gross profit as a percentage of revenue.',
  },
  'growth decomposition check': {
    latex: 'g \\approx \\Delta \\text{Labor} + \\Delta \\text{Capital} + \\Delta \\text{TFP}',
    description: 'Breaks economic growth into labor, capital, and productivity components.',
  },
  'hedge ratio': {
    latex: 'h^* = \\rho\\frac{\\sigma_S}{\\sigma_F}',
    description: 'Minimum-variance futures hedge ratio.',
  },
  'holding-period return': {
    latex: 'HPR = \\frac{P_1 - P_0 + D_1}{P_0}',
    description: 'Total return over a holding period including income.',
  },
  'income elasticity': {
    latex: 'E_I = \\frac{\\%\\Delta Q_d}{\\%\\Delta I}',
    description: 'Demand sensitivity to income changes.',
  },
  'inflation rate': {
    latex: '\\pi = \\frac{CPI_t - CPI_{t-1}}{CPI_{t-1}}',
    description: 'Measures percentage change in the price index.',
  },
  'incentive fee': {
    latex: '\\text{Incentive fee} = c\\times\\max(R - \\text{Hurdle}, 0)\\times AUM',
    description: 'Performance-based fee earned when return exceeds a stated hurdle.',
  },
  'incremental npv bridge': {
    latex: '\\Delta NPV = NPV_{with\\ project} - NPV_{without\\ project}',
    description: 'Measures the incremental value created by accepting a project or policy change.',
  },
  'index replication trade-off': {
    latex: '\\text{Replication gap} = \\text{Tracking error} + \\text{Cost} + \\text{Liquidity drag}',
    description: 'Compares full replication, sampling, and synthetic implementation tradeoffs.',
  },
  'independence and objectivity': {
    latex: '\\text{Objectivity risk} = \\text{Benefit} + \\text{Pressure} + \\text{Disclosure gap}',
    description: 'Identifies benefits or pressures that may compromise independent judgment.',
  },
  'indirect operating cash flow': {
    latex: 'CFO = NI + \\text{Noncash charges} - \\Delta NWC',
    description: 'Derives operating cash flow from net income and working-capital changes.',
  },
  'information ratio': {
    latex: 'IR = \\frac{R_p - R_b}{\\sigma(R_p - R_b)}',
    description: 'Active return per unit of active risk.',
  },
  'information ratio bridge': {
    latex: 'IR = \\frac{R_A}{\\sigma_A}',
    description: 'Links active return and active risk in manager evaluation.',
  },
  'information ratio screen': {
    latex: 'IR = \\frac{R_A}{\\sigma_A}',
    description: 'Screens active return for the active risk taken.',
  },
  'implementation shortfall bridge': {
    latex: '\\text{Shortfall} = \\text{Decision price return} - \\text{Execution price return} - \\text{Fees}',
    description: 'Measures performance lost between investment decision and execution.',
  },
  'infrastructure cash-flow stability': {
    latex: '\\text{Stability} = \\frac{\\text{Contracted cash flow}}{\\text{Total projected cash flow}}',
    description: 'Measures how much infrastructure cash flow is contractually supported.',
  },
  'insurance coverage gap': {
    latex: '\\text{Coverage gap} = \\text{Required coverage} - \\text{Existing coverage}',
    description: 'Identifies unfunded risk transfer need in private wealth planning.',
  },
  'justified multiple check': {
    latex: '\\frac{P_0}{E_1} = \\frac{1-b}{r-g}',
    description: 'Links a justified P/E multiple to payout, required return, and growth.',
  },
  'interest coverage': {
    latex: '\\text{Interest coverage} = \\frac{EBIT}{\\text{Interest expense}}',
    description: 'Measures ability to cover interest expense with operating profit.',
  },
  'interest rate parity': {
    latex: 'F_{d/f} = S_{d/f}\\frac{1+r_d}{1+r_f}',
    description: 'Forward exchange rate implied by domestic and foreign interest rates.',
  },
  'interest rate parity signal': {
    latex: 'F_{d/f} = S_{d/f}\\frac{1+r_d}{1+r_f}',
    description: 'Checks whether a forward currency quote is consistent with interest-rate parity.',
  },
  'internal rate of return': {
    latex: '0 = \\sum_{t=0}^{N}\\frac{CF_t}{(1+IRR)^t}',
    description: 'Discount rate that sets project net present value to zero.',
  },
  'intrinsic value': {
    latex: '\\text{Intrinsic value}_{call} = \\max(S - X, 0)',
    description: 'Immediate exercise value of an option.',
  },
  'inventory days': {
    latex: 'DIO = \\frac{\\text{Average inventory}}{\\text{COGS}}\\times365',
    description: 'Average number of days inventory is held.',
  },
  'key-rate duration check': {
    latex: '\\frac{\\Delta P}{P} \\approx -\\sum_k KRD_k\\Delta y_k',
    description: 'Estimates bond price impact from nonparallel curve shifts.',
  },
  'liquidity haircut check': {
    latex: 'V_{liquidation} = V_{reported}(1 - h_{liquidity})',
    description: 'Adjusts reported value for expected liquidity discount.',
  },
  'liquidity premium': {
    latex: 'r_{required} = r_{liquid} + \\text{Liquidity premium}',
    description: 'Adds compensation for bearing illiquidity.',
  },
  'liquidity reserve coverage': {
    latex: '\\text{Reserve coverage} = \\frac{\\text{Liquid reserves}}{\\text{Expected cash needs}}',
    description: 'Tests whether liquid assets cover forecast spending or liability needs.',
  },
  'liquidity-adjusted implementation cost': {
    latex: '\\text{Cost}_{liq} = \\text{Spread} + \\text{Market impact} + \\text{Delay cost}',
    description: 'Adds liquidity costs to implementation analysis.',
  },
  'limited partner liquidity reserve': {
    latex: '\\text{LP reserve} = \\text{Unfunded commitments} + \\text{Expected capital calls} - \\text{Expected distributions}',
    description: 'Sizes liquid reserves for private-market commitment obligations.',
  },
  'loyalty and prudence': {
    latex: '\\text{Duty met} = \\text{Client benefit} + \\text{Prudent process} - \\text{Conflicts}',
    description: 'Checks whether a client decision is loyal and prudent.',
  },
  'macaulay duration': {
    latex: 'D_{mac} = \\frac{\\sum_t t\\,PV(CF_t)}{\\sum_t PV(CF_t)}',
    description: 'Weighted average timing of bond cash flows.',
  },
  'management fee': {
    latex: '\\text{Management fee} = \\text{Fee rate}\\times\\text{Assets under management}',
    description: 'Periodic asset-based fee charged by a manager.',
  },
  'marginal cost': {
    latex: 'MC = \\frac{\\Delta TC}{\\Delta Q}',
    description: 'Additional total cost from producing one more unit.',
  },
  'marginal revenue': {
    latex: 'MR = \\frac{\\Delta TR}{\\Delta Q}',
    description: 'Additional total revenue from selling one more unit.',
  },
  'manager monitoring trigger': {
    latex: '\\text{Trigger} = |R_A| > \\text{Review threshold} \\;\\lor\\; \\text{Process breach}',
    description: 'Defines when active manager performance or process requires review.',
  },
  'manager overlap check': {
    latex: '\\text{Overlap}_{A,B} = \\sum_i \\min(w_{A,i}, w_{B,i})',
    description: 'Measures duplication between manager holdings or strategies.',
  },
  'market capitalization': {
    latex: '\\text{Market cap} = P_0 \\times \\text{Shares outstanding}',
    description: 'Equity market value of a company.',
  },
  'market manipulation': {
    latex: '\\text{Manipulation risk} = \\text{Artificial price} + \\text{Intent to mislead}',
    description: 'Identifies actions designed to distort prices or trading volume.',
  },
  'material nonpublic information': {
    latex: '\\text{Trading allowed} = \\neg(\\text{Material} \\cap \\text{Nonpublic})',
    description: 'Screens whether information blocks trading or recommendation activity.',
  },
  'modified duration': {
    latex: 'D_{mod} = \\frac{D_{mac}}{1 + y/m}',
    description: 'Price sensitivity measure adjusted for compounding frequency.',
  },
  'money multiple': {
    latex: 'MOIC = \\frac{\\text{Total value received}}{\\text{Invested capital}}',
    description: 'Multiple of invested capital returned or remaining in value.',
  },
  'money multiplier': {
    latex: 'm = \\frac{1}{\\text{Reserve requirement}}',
    description: 'Potential money supply expansion from reserve banking.',
  },
  'multi-sleeve monitoring trigger': {
    latex: '\\text{Total drift} = \\sum_s |w_s - w_{target,s}|',
    description: 'Flags multi-sleeve portfolio drift that requires monitoring or rebalance.',
  },
  'net operating income': {
    latex: 'NOI = \\text{Rental income} - \\text{Operating expenses}',
    description: 'Property income before financing and taxes.',
  },
  'net profit margin': {
    latex: '\\text{Net margin} = \\frac{\\text{Net income}}{\\text{Revenue}}',
    description: 'Net income earned per dollar of revenue.',
  },
  'net return after fees': {
    latex: 'R_{net} = R_{gross} - \\text{Management fee} - \\text{Incentive fee}',
    description: 'Return after investment management and performance fees.',
  },
  'net-of-fee return check': {
    latex: 'R_{net} = R_{gross} - \\text{Management fees} - \\text{Carried interest}',
    description: 'Converts private-market gross return into investor net return.',
  },
  'net present value': {
    latex: 'NPV = \\sum_{t=0}^{N}\\frac{CF_t}{(1+r)^t}',
    description: 'Present value of project cash flows net of investment.',
  },
  'no-arbitrage carry signal': {
    latex: 'F_0 = S_0e^{(r+c-y)T}',
    description: 'Checks whether forward or futures pricing is consistent with carry costs and benefits.',
  },
  'option breakeven': {
    latex: '\\text{Call breakeven} = X + \\text{Premium}',
    description: 'Underlying price at which an option position breaks even at expiration.',
  },
  'option collar payoff': {
    latex: '\\text{Collar payoff} = S_T + \\max(K_p-S_T,0) - \\max(S_T-K_c,0)',
    description: 'Combines stock, long put, and short call payoff for downside protection.',
  },
  'option payoff check': {
    latex: '\\text{Option payoff} = \\max(\\pm(S_T-X),0)',
    description: 'Checks option payoff direction for calls and puts.',
  },
  'option-adjusted spread signal': {
    latex: 'OAS \\approx Z\\text{-spread} - \\text{Option cost}',
    description: 'Separates credit/liquidity spread from embedded option value.',
  },
  'out-of-sample validation score': {
    latex: '\\text{Validation error} = \\frac{1}{n}\\sum_{i=1}^{n}(y_i-\\hat{y}_i)^2',
    description: 'Checks prediction error on observations not used to estimate the model.',
  },
  'operating leverage': {
    latex: 'DOL = \\frac{\\%\\Delta EBIT}{\\%\\Delta Sales}',
    description: 'Sensitivity of operating income to revenue changes.',
  },
  'payback period': {
    latex: '\\text{Payback} = \\text{Years before recovery} + \\frac{\\text{Unrecovered cost}}{\\text{Next-year cash flow}}',
    description: 'Time required to recover an initial investment.',
  },
  'performance presentation': {
    latex: '\\text{Presentation standard} = \\text{Fair} + \\text{Accurate} + \\text{Complete}',
    description: 'Checks whether presented performance avoids misleading claims.',
  },
  'present value': {
    latex: 'PV = \\frac{FV}{(1+r)^N}',
    description: 'Discounts a future value back to the present.',
  },
  'plain bond price': {
    latex: 'P = \\sum_{t=1}^{N}\\frac{C}{(1+y)^t} + \\frac{FV}{(1+y)^N}',
    description: 'Present value of coupon and principal cash flows.',
  },
  'portfolio role bridge': {
    latex: '\\text{Allocation fit} = \\text{Return role} + \\text{Risk role} + \\text{Liquidity role}',
    description: 'Connects an alternative investment to its intended portfolio function.',
  },
  'portfolio variance': {
    latex: '\\sigma_p^2 = w^T\\Sigma w',
    description: 'Portfolio variance from weights and covariance matrix.',
  },
  'policy weight drift': {
    latex: '\\text{Drift}_i = w_i - w_{policy,i}',
    description: 'Measures asset-class weight distance from policy targets.',
  },
  'price earnings ratio': {
    latex: 'P/E = \\frac{P_0}{EPS}',
    description: 'Price paid per unit of earnings.',
  },
  'price elasticity': {
    latex: 'E_d = \\frac{\\%\\Delta Q_d}{\\%\\Delta P}',
    description: 'Quantity demanded sensitivity to price changes.',
  },
  'priority of transactions': {
    latex: '\\text{Trade priority} = \\text{Clients} > \\text{Employer accounts} > \\text{Personal accounts}',
    description: 'Orders trade priority to protect client interests before firm or personal accounts.',
  },
  'price return': {
    latex: 'R_P = \\frac{P_1 - P_0}{P_0}',
    description: 'Return from price change only.',
  },
  'protection cost screen': {
    latex: '\\text{Protection cost} = \\text{Option premium} + \\text{Hedge carry cost}',
    description: 'Measures the cost paid for downside protection or risk reduction.',
  },
  'private company discount screen': {
    latex: 'V_{private} = V_{public}(1 - D_{size} - D_{liquidity} - D_{control})',
    description: 'Adjusts public-company valuation for private-company discounts.',
  },
  'private credit coverage screen': {
    latex: '\\text{Coverage} = \\frac{EBITDA}{\\text{Cash interest} + \\text{Required amortization}}',
    description: 'Tests private credit borrower capacity to cover debt service.',
  },
  'purchasing power parity': {
    latex: '\\frac{S_1}{S_0} \\approx \\frac{1+\\pi_d}{1+\\pi_f}',
    description: 'Exchange-rate change implied by relative inflation.',
  },
  'put option payoff': {
    latex: '\\text{Put payoff} = \\max(X - S_T, 0)',
    description: 'Expiration payoff for a long put option.',
  },
  'put-call parity': {
    latex: 'C + \\frac{X}{(1+r)^T} = P + S_0',
    description: 'No-arbitrage relation among European options, underlying, and strike bond.',
  },
  'quality of earnings ratio': {
    latex: '\\text{Quality of earnings} = \\frac{CFO}{\\text{Net income}}',
    description: 'Compares cash generation with accounting earnings.',
  },
  'quick ratio': {
    latex: '\\text{Quick ratio} = \\frac{\\text{Cash} + \\text{Marketable securities} + \\text{Receivables}}{\\text{Current liabilities}}',
    description: 'Liquidity ratio excluding inventory and less liquid current assets.',
  },
  'r-squared usefulness check': {
    latex: 'R^2 = 1 - \\frac{SSE}{SST}',
    description: 'Measures sample fit while reminding the analyst to test economic usefulness.',
  },
  'real estate value': {
    latex: 'V = \\frac{NOI}{\\text{Capitalization rate}}',
    description: 'Income-capitalization estimate of property value.',
  },
  'real interest rate': {
    latex: 'r_{real} \\approx r_{nominal} - \\pi',
    description: 'Approximate inflation-adjusted interest rate.',
  },
  'real rate bridge': {
    latex: 'r_{real} \\approx r_{nominal} - \\pi',
    description: 'Separates nominal rate movement from inflation expectations.',
  },
  'rebalancing band': {
    latex: '\\text{Rebalance if } |w_i - w_i^*| > \\text{Band}_i',
    description: 'Rule for rebalancing when allocation drift exceeds tolerance.',
  },
  'rebalancing tolerance band': {
    latex: '\\text{Rebalance if } |w_i - w_i^*| > \\text{Tolerance band}_i',
    description: 'Determines whether policy drift requires trading.',
  },
  'regression prediction error': {
    latex: 'e_i = y_i - \\hat{y}_i',
    description: 'Difference between observed and predicted dependent variable.',
  },
  'regression slope': {
    latex: 'b_1 = \\frac{\\operatorname{Cov}(X,Y)}{\\sigma_X^2}',
    description: 'Change in predicted Y for a one-unit change in X.',
  },
  'required return': {
    latex: 'r = \\frac{D_1}{P_0} + g',
    description: 'Required return implied by dividend yield plus growth.',
  },
  'residual income value': {
    latex: 'V_0 = B_0 + \\sum_{t=1}^{\\infty}\\frac{RI_t}{(1+r)^t}',
    description: 'Values equity from book value plus discounted residual income.',
  },
  'residual risk bridge': {
    latex: '\\text{Residual risk} = \\text{Gross exposure} - \\text{Hedged exposure}',
    description: 'Measures exposure remaining after a hedge or overlay.',
  },
  'retention ratio': {
    latex: 'b = 1 - \\text{Payout ratio}',
    description: 'Share of earnings retained in the business.',
  },
  'return on equity': {
    latex: 'ROE = \\frac{\\text{Net income}}{\\text{Average equity}}',
    description: 'Profitability earned on shareholder equity.',
  },
  'risk budget use': {
    latex: '\\text{Risk budget use} = \\frac{\\text{Allocated risk}}{\\text{Total risk budget}}',
    description: 'Tracks how much of the portfolio risk budget is consumed.',
  },
  'risk-adjusted appraisal check': {
    latex: '\\text{Appraisal ratio} = \\frac{\\alpha}{\\sigma_{residual}}',
    description: 'Evaluates excess return relative to residual risk.',
  },
  'selection effect bridge': {
    latex: '\\text{Selection effect}_i = w_{b,i}(R_{p,i} - R_{b,i})',
    description: 'Measures attribution from security or manager selection within a segment.',
  },
  'share repurchase yield': {
    latex: '\\text{Repurchase yield} = \\frac{\\text{Net repurchases}}{\\text{Market capitalization}}',
    description: 'Capital returned through net share repurchases relative to market value.',
  },
  'sharpe ratio': {
    latex: 'S = \\frac{R_p - R_f}{\\sigma_p}',
    description: 'Excess return per unit of total risk.',
  },
  'spot-rate bond value': {
    latex: 'P = \\sum_{t=1}^{N}\\frac{CF_t}{(1+s_t)^t}',
    description: 'Bond value using a spot rate for each cash-flow maturity.',
  },
  'spread duration bridge': {
    latex: '\\frac{\\Delta P}{P} \\approx -D_{spread}\\Delta s',
    description: 'Estimates price impact from a credit-spread change.',
  },
  'standard deviation': {
    latex: '\\sigma = \\sqrt{\\sigma^2}',
    description: 'Dispersion measure in the same units as the underlying variable.',
  },
  'standard error interpretation': {
    latex: 'SE(\\hat{b}) = \\frac{s_e}{\\sqrt{\\sum (X_i-\\bar{X})^2}}',
    description: 'Measures sampling uncertainty around an estimated coefficient.',
  },
  'structured cash-flow sensitivity': {
    latex: '\\Delta V \\approx \\sum_t \\frac{\\Delta CF_t}{(1+r_t)^t}',
    description: 'Measures value sensitivity to collateral or tranche cash-flow changes.',
  },
  'suitability': {
    latex: '\\text{Suitable} = \\text{IPS fit} \\cap \\text{Risk capacity} \\cap \\text{Client objective}',
    description: 'Checks whether a recommendation fits client circumstances.',
  },
  'suitability constraint bridge': {
    latex: '\\text{Feasible recommendation} = \\text{Objective fit} \\cap \\text{Constraint fit}',
    description: 'Links client objectives and constraints to a suitable recommendation.',
  },
  'supervisory escalation path': {
    latex: '\\text{Escalate if } \\text{Violation risk} > \\text{Supervisor control threshold}',
    description: 'Defines when a supervision issue requires escalation.',
  },
  'supervisory response test': {
    latex: '\\text{Response quality} = \\text{Detect} + \\text{Prevent} + \\text{Escalate}',
    description: 'Tests whether supervisory controls reasonably address a potential violation.',
  },
  'supervisory responsibility': {
    latex: '\\text{Supervisor control} = \\text{Policy} + \\text{Training} + \\text{Monitoring} + \\text{Escalation}',
    description: 'Summarizes a reasonable supervisory-control framework.',
  },
  'sustainable growth': {
    latex: 'g = b \\times ROE',
    description: 'Growth rate supported by retained earnings and return on equity.',
  },
  'swap net payment': {
    latex: '\\text{Net swap payment} = (R_{fixed} - R_{floating}) \\times \\text{Notional}',
    description: 'Net interest payment on a plain-vanilla swap leg comparison.',
  },
  'tactical active-risk budget': {
    latex: '\\sigma_A^2 = w_A^T\\Sigma_Aw_A',
    description: 'Translates tactical active weights into active risk usage.',
  },
  'test statistic': {
    latex: 't = \\frac{\\hat{\\theta} - \\theta_0}{SE(\\hat{\\theta})}',
    description: 'Standardized distance between an estimate and the null hypothesis value.',
  },
  'time value': {
    latex: '\\text{Time value} = \\text{Option premium} - \\text{Intrinsic value}',
    description: 'Option value beyond immediate exercise value.',
  },
  'total active-risk budget': {
    latex: '\\sigma_A = \\sqrt{w_A^T\\Sigma_Aw_A}',
    description: 'Measures total active risk from active weights and active covariance.',
  },
  'total return': {
    latex: 'R_T = \\frac{P_1 - P_0 + D_1}{P_0}',
    description: 'Return including price change and cash income.',
  },
  'tracking error': {
    latex: 'TE = \\sigma(R_p - R_b)',
    description: 'Volatility of active return relative to a benchmark.',
  },
  'treynor ratio': {
    latex: 'T = \\frac{R_p - R_f}{\\beta_p}',
    description: 'Excess return per unit of systematic risk.',
  },
  variance: {
    latex: '\\sigma^2 = \\frac{\\sum_{i=1}^{n}(X_i-\\bar{X})^2}{n-1}',
    description: 'Average squared deviation from the sample mean.',
  },
  'weighted average cost of capital': {
    latex: 'WACC = w_dr_d(1-T) + w_pr_p + w_er_e',
    description: 'Required return for the firm across capital sources.',
  },
};

const aliasMap: Record<string, string> = {
  'capm': 'capital asset pricing model',
  'dcf value bridge': 'discounted cash flow value',
  'equity factor exposure check': 'factor exposure check',
  'hedge ratio check': 'hedge ratio',
  'option adjusted spread signal': 'option-adjusted spread signal',
  'pension adjustment signal': 'adjusted leverage bridge',
  'payout sustainability signal': 'dividend payout ratio',
  'private equity exit sensitivity': 'exit multiple sensitivity',
  'target leverage check': 'debt to equity',
  'wacc': 'weighted average cost of capital',
};

const normalizedExactFormulas: Record<string, FormulaLexiconEntry> = Object.fromEntries(
  Object.entries(exactFormulas).map(([key, entry]) => [normalizeFormulaName(key), entry]),
);
const normalizedAliasMap: Record<string, string> = Object.fromEntries(
  Object.entries(aliasMap).map(([key, value]) => [normalizeFormulaName(key), normalizeFormulaName(value)]),
);

function normalizeFormulaName(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function displayName(value: unknown): string {
  return String(value || 'Decision metric').replace(/[^a-zA-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lookupFormula(name: unknown): FormulaLexiconEntry | undefined {
  const key = normalizeFormulaName(name);
  return normalizedExactFormulas[key] || normalizedExactFormulas[normalizedAliasMap[key]];
}

export interface CfaFormulaInput {
  level?: string;
  topicId?: string;
  name?: string;
  index?: number;
}

function fallbackFormula({ level = 'level1', topicId = 'cfa', name = 'Decision metric', index = 0 }: CfaFormulaInput): FormulaLexiconEntry {
  const label = displayName(name);
  const suffix = index + 1;
  if (level === 'level3') {
    return {
      latex: `\\text{${label}}_{${suffix}} = \\sum_j w_j \\times \\text{case factor}_j`,
      description: `${name} is evaluated as a weighted Level III case-factor rule tied to the selected command word and portfolio constraint.`,
    };
  }
  if (level === 'level2') {
    return {
      latex: `\\text{${label}}_{${suffix}} = \\text{observed metric} - \\text{required benchmark}`,
      description: `${name} compares the item-set exhibit metric with the benchmark needed for the analyst conclusion.`,
    };
  }
  if (topicId === 'ethics') {
    return {
      latex: `\\text{${label}}_{${suffix}} = \\text{duty met} - \\text{violation risk}`,
      description: `${name} is applied as an ethics decision screen that weighs the duty satisfied against violation risk.`,
    };
  }
  return {
    latex: `\\text{${label}}_{${suffix}} = \\frac{\\text{measured value}}{\\text{required value}}`,
    description: `${name} converts the stated facts into a comparable Level I exam metric and conclusion.`,
  };
}

export function enrichCfaFormula(input?: CfaFormulaInput | null): FormulaLexiconEntry {
  const entry = lookupFormula(input?.name);
  if (entry) return entry;
  return fallbackFormula(input || {});
}

export function isGenericCfaFormulaText(value: unknown): boolean {
  return /Relevant input|Decision base|Case input|Policy input|Input_\\{|Decision_\\{|Input\\s*\\}?\s*\\\\rightarrow\\s*\\\\text\\{Decision/i.test(String(value || ''));
}
