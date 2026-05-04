const baseErrorCategories = ['concept', 'calculation', 'formula', 'misread'];

function q({
  id,
  topic,
  learningObjective,
  question,
  options,
  correct,
  explanation,
  difficulty = 'foundation',
  formula,
  tags = [],
  errorCategories = baseErrorCategories,
}) {
  return {
    id,
    topic,
    learningObjective,
    question,
    options,
    correct,
    explanation,
    difficulty,
    formula,
    tags,
    errorCategories,
  };
}

export const cfaLevel1Objectives = {
  economics: [
    {
      id: 'econ-lo1',
      domain: 'cfa',
      topic: 'economics',
      title: 'Analyze market forces and elasticity',
      description: 'Use supply, demand, elasticity, and surplus concepts to explain price and quantity changes.',
      weight: '6-9%',
      tags: ['microeconomics', 'elasticity'],
    },
    {
      id: 'econ-lo2',
      domain: 'cfa',
      topic: 'economics',
      title: 'Interpret macro growth and policy indicators',
      description: 'Connect GDP, inflation, fiscal policy, and monetary policy to business cycle outcomes.',
      weight: '6-9%',
      tags: ['macroeconomics', 'policy'],
    },
    {
      id: 'econ-lo3',
      domain: 'cfa',
      topic: 'economics',
      title: 'Read currency and trade relationships',
      description: 'Explain exchange-rate quotes, interest parity intuition, and trade balance drivers.',
      weight: '6-9%',
      tags: ['currency', 'international-trade'],
    },
  ],
  fsa: [
    {
      id: 'fsa-lo1',
      domain: 'cfa',
      topic: 'fsa',
      title: 'Connect the core financial statements',
      description: 'Trace how accrual accounting events flow through income statement, balance sheet, and cash flow statement.',
      weight: '11-14%',
      tags: ['statements', 'accruals'],
    },
    {
      id: 'fsa-lo2',
      domain: 'cfa',
      topic: 'fsa',
      title: 'Evaluate ratio signals and adjustments',
      description: 'Use liquidity, solvency, profitability, and DuPont ratios while recognizing accounting choices.',
      weight: '11-14%',
      tags: ['ratios', 'analysis'],
    },
    {
      id: 'fsa-lo3',
      domain: 'cfa',
      topic: 'fsa',
      title: 'Analyze inventories, long-lived assets, and taxes',
      description: 'Explain how inventory methods, depreciation, impairment, and deferred taxes affect reported performance.',
      weight: '11-14%',
      tags: ['inventories', 'depreciation', 'taxes'],
    },
  ],
  corporate: [
    {
      id: 'corp-lo1',
      domain: 'cfa',
      topic: 'corporate',
      title: 'Make capital budgeting decisions',
      description: 'Apply NPV, IRR, payback, and project risk logic to investment decisions.',
      weight: '6-9%',
      tags: ['capital-budgeting', 'npv'],
    },
    {
      id: 'corp-lo2',
      domain: 'cfa',
      topic: 'corporate',
      title: 'Estimate cost of capital and capital structure effects',
      description: 'Combine debt, equity, taxes, and leverage considerations into financing choices.',
      weight: '6-9%',
      tags: ['wacc', 'leverage'],
    },
    {
      id: 'corp-lo3',
      domain: 'cfa',
      topic: 'corporate',
      title: 'Assess working capital and governance choices',
      description: 'Evaluate liquidity policies, short-term financing, and shareholder governance alignment.',
      weight: '6-9%',
      tags: ['working-capital', 'governance'],
    },
  ],
  equity: [
    {
      id: 'eq-lo1',
      domain: 'cfa',
      topic: 'equity',
      title: 'Classify equity markets and security types',
      description: 'Distinguish common shares, preferred shares, indexes, market structures, and order types.',
      weight: '11-14%',
      tags: ['market-structure', 'securities'],
    },
    {
      id: 'eq-lo2',
      domain: 'cfa',
      topic: 'equity',
      title: 'Value equities with cash-flow and multiple methods',
      description: 'Apply dividend discount, free cash flow, and relative valuation tools with clean assumptions.',
      weight: '11-14%',
      tags: ['valuation', 'dividends'],
    },
    {
      id: 'eq-lo3',
      domain: 'cfa',
      topic: 'equity',
      title: 'Interpret industry and company analysis',
      description: 'Connect competitive forces, life-cycle stage, and accounting quality to equity conclusions.',
      weight: '11-14%',
      tags: ['industry-analysis', 'strategy'],
    },
  ],
  'fixed-income': [
    {
      id: 'fi-lo1',
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Price bonds and interpret yield measures',
      description: 'Discount fixed-income cash flows and compare coupon rate, current yield, YTM, and spot-rate logic.',
      weight: '11-14%',
      tags: ['bond-pricing', 'yield'],
    },
    {
      id: 'fi-lo2',
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Measure duration, convexity, and interest-rate risk',
      description: 'Use duration and convexity to estimate bond price sensitivity to yield changes.',
      weight: '11-14%',
      tags: ['duration', 'convexity'],
    },
    {
      id: 'fi-lo3',
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Analyze credit and structured fixed income',
      description: 'Relate credit spreads, seniority, collateral, call features, and securitization to bond risk.',
      weight: '11-14%',
      tags: ['credit-risk', 'structured-products'],
    },
  ],
  derivatives: [
    {
      id: 'deriv-lo1',
      domain: 'cfa',
      topic: 'derivatives',
      title: 'Explain derivative contracts and payoffs',
      description: 'Identify forward, futures, option, and swap payoff profiles and the role of clearing.',
      weight: '5-8%',
      tags: ['payoffs', 'contracts'],
    },
    {
      id: 'deriv-lo2',
      domain: 'cfa',
      topic: 'derivatives',
      title: 'Apply no-arbitrage pricing relationships',
      description: 'Use cost-of-carry, put-call parity, and forward-rate logic to price simple derivatives.',
      weight: '5-8%',
      tags: ['no-arbitrage', 'pricing'],
    },
    {
      id: 'deriv-lo3',
      domain: 'cfa',
      topic: 'derivatives',
      title: 'Use derivatives for risk management',
      description: 'Connect hedge direction, basis risk, and option asymmetry to portfolio risk objectives.',
      weight: '5-8%',
      tags: ['hedging', 'risk-management'],
    },
  ],
  alternatives: [
    {
      id: 'alt-lo1',
      domain: 'cfa',
      topic: 'alternatives',
      title: 'Compare alternative investment structures',
      description: 'Distinguish real estate, private equity, hedge funds, infrastructure, commodities, and private credit.',
      weight: '7-10%',
      tags: ['asset-classes', 'structures'],
    },
    {
      id: 'alt-lo2',
      domain: 'cfa',
      topic: 'alternatives',
      title: 'Evaluate valuation and fee mechanics',
      description: 'Apply NAV, cap rates, carried interest, hurdle rates, and fee waterfalls at a foundation level.',
      weight: '7-10%',
      tags: ['valuation', 'fees'],
    },
    {
      id: 'alt-lo3',
      domain: 'cfa',
      topic: 'alternatives',
      title: 'Assess alternative investment risk and diversification',
      description: 'Explain illiquidity, leverage, appraisal smoothing, lockups, and diversification benefits.',
      weight: '7-10%',
      tags: ['risk', 'diversification'],
    },
  ],
  portfolio: [
    {
      id: 'pm-lo1',
      domain: 'cfa',
      topic: 'portfolio',
      title: 'Build portfolio risk and return intuition',
      description: 'Calculate expected return, variance, covariance, correlation, and diversification effects.',
      weight: '8-12%',
      tags: ['risk-return', 'diversification'],
    },
    {
      id: 'pm-lo2',
      domain: 'cfa',
      topic: 'portfolio',
      title: 'Apply CAPM and portfolio construction concepts',
      description: 'Use beta, market risk premium, efficient frontier, and allocation constraints in portfolio decisions.',
      weight: '8-12%',
      tags: ['capm', 'allocation'],
    },
    {
      id: 'pm-lo3',
      domain: 'cfa',
      topic: 'portfolio',
      title: 'Understand investment policy and performance evaluation',
      description: 'Link objectives, constraints, rebalancing, benchmarks, and attribution to portfolio governance.',
      weight: '8-12%',
      tags: ['ips', 'performance'],
    },
  ],
};

export const cfaLevel1Content = {
  economics: {
    title: 'Economics',
    weight: '6-9%',
    sections: [
      {
        title: 'Supply, Demand, and Elasticity',
        content:
          'Microeconomic analysis starts with how buyers and sellers react to price. A demand curve slopes downward because lower prices make a good more attractive, while a supply curve slopes upward because higher prices reward additional production. The market-clearing price is the point where quantity demanded equals quantity supplied.\n\nElasticity turns this picture into a decision tool. If demand is elastic, a small price increase can reduce quantity enough to lower revenue. If demand is inelastic, price increases may lift revenue because quantity changes less. Cross-price elasticity helps separate substitutes from complements, and income elasticity separates normal goods from inferior goods.',
        keyPoints: [
          'Elastic demand means quantity responds strongly to price changes.',
          'A binding price ceiling creates shortage; a binding price floor creates surplus.',
          'Substitutes have positive cross-price elasticity; complements have negative cross-price elasticity.',
        ],
      },
      {
        title: 'Growth, Inflation, and Policy',
        content:
          'Macroeconomics studies aggregate output, employment, price levels, and policy. GDP can be read through expenditure as consumption plus investment plus government spending plus net exports. Real GDP removes inflation and is the better measure of quantity growth.\n\nFiscal policy works through spending and taxes. Monetary policy works through policy rates, reserves, and liquidity conditions. Expansionary policy can support demand during contraction, but if the economy is near capacity it may mostly create inflation pressure.',
        keyPoints: [
          'Real GDP adjusts nominal GDP for price-level changes.',
          'Expansionary fiscal policy means higher government spending, lower taxes, or both.',
          'Tighter monetary policy usually raises discount rates and cools interest-sensitive demand.',
        ],
      },
      {
        title: 'Currencies and International Trade',
        content:
          'Exchange rates link economies. A direct quote states the domestic currency price of one unit of foreign currency; an indirect quote states the foreign currency price of one domestic unit. Currency appreciation can reduce export competitiveness but lower the local-currency cost of imports.\n\nInterest-rate parity is a no-arbitrage relationship between spot exchange rates, forward exchange rates, and interest-rate differentials. In practice, currency returns also reflect risk premia, capital flows, and policy credibility.',
        keyPoints: [
          'A stronger domestic currency makes foreign goods cheaper for domestic buyers.',
          'Forward rates often reflect interest-rate differentials, not a guaranteed forecast.',
          'Trade balances respond to prices, incomes, exchange rates, and global demand.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Price Elasticity of Demand',
        latex: 'E_d = \\frac{\\%\\Delta Q_d}{\\%\\Delta P}',
        description: 'Measures quantity-demanded sensitivity to price.',
      },
      {
        name: 'GDP Expenditure Approach',
        latex: 'GDP = C + I + G + (X - M)',
        description: 'Gross domestic product from aggregate spending components.',
      },
      {
        name: 'Fisher Relation',
        latex: '1 + R \\approx (1 + r)(1 + \\pi)',
        description: 'Links nominal rate, real rate, and expected inflation.',
      },
      {
        name: 'Money Multiplier',
        latex: 'Multiplier = \\frac{1}{Reserve\\ Requirement}',
        description: 'Simple deposit expansion multiplier under stylized assumptions.',
      },
    ],
  },
  fsa: {
    title: 'Financial Statement Analysis',
    weight: '11-14%',
    sections: [
      {
        title: 'Statements as One System',
        content:
          'Financial statements are linked views of the same business. The income statement explains performance over a period, the balance sheet shows resources and claims at a point in time, and the cash flow statement reconciles accrual earnings to cash movement. The statement of changes in equity explains owner-related changes.\n\nAccrual accounting records revenue when earned and expenses when incurred, not necessarily when cash changes hands. That makes earnings useful but also makes analysis dependent on estimates such as credit losses, depreciation lives, and inventory costs.',
        keyPoints: [
          'Assets equal liabilities plus equity.',
          'Net income increases retained earnings after dividends.',
          'Cash flow from operations can diverge from net income because of working capital and noncash charges.',
        ],
      },
      {
        title: 'Ratio Analysis and Quality',
        content:
          'Ratio analysis translates statements into comparable signals. Liquidity ratios focus on near-term obligations, solvency ratios focus on long-term financial risk, profitability ratios assess margins and returns, and activity ratios describe how efficiently assets support sales.\n\nRatios need context. A high current ratio may signal safety or idle working capital. A rising return on equity may reflect better margins, faster turnover, or simply more leverage. Good analysis decomposes the source before judging the result.',
        keyPoints: [
          'DuPont analysis separates profitability, efficiency, and leverage.',
          'Compare ratios across time, peers, and business models.',
          'Accounting choices can make otherwise similar firms look different.',
        ],
      },
      {
        title: 'Inventories, Assets, and Taxes',
        content:
          'Inventory cost flow assumptions affect gross profit and inventory carrying values when prices change. Long-lived asset accounting uses capitalization, depreciation, impairment, and disposal rules to spread or recognize costs. Deferred tax assets and liabilities arise when accounting income and taxable income recognize items in different periods.\n\nThe analyst goal is not to memorize isolated rules. It is to understand how methods affect margins, assets, cash taxes, leverage ratios, and comparability.',
        keyPoints: [
          'In rising prices, FIFO usually reports higher ending inventory and higher gross profit than LIFO.',
          'Straight-line depreciation creates equal expense each period; accelerated methods front-load expense.',
          'Deferred taxes are timing differences, not automatically value creation or destruction.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Accounting Equation',
        latex: 'Assets = Liabilities + Equity',
        description: 'The balance sheet identity.',
      },
      {
        name: 'Current Ratio',
        latex: 'Current\\ Ratio = \\frac{Current\\ Assets}{Current\\ Liabilities}',
        description: 'Measures short-term liquidity coverage.',
      },
      {
        name: 'DuPont ROE',
        latex: 'ROE = Net\\ Margin \\times Asset\\ Turnover \\times Equity\\ Multiplier',
        description: 'Decomposes return on equity into margin, efficiency, and leverage.',
      },
      {
        name: 'Indirect CFO',
        latex: 'CFO = NI + Noncash\\ Charges - \\Delta NWC',
        description: 'Simplified bridge from accrual earnings to operating cash flow.',
      },
    ],
  },
  corporate: {
    title: 'Corporate Issuers',
    weight: '6-9%',
    sections: [
      {
        title: 'Capital Budgeting',
        content:
          'Capital budgeting asks whether a project creates value. Net present value is the clearest rule: accept positive-NPV projects because discounted benefits exceed discounted costs. IRR is intuitive but can mislead when cash flows change signs or project scale differs.\n\nGood capital budgeting is incremental. Include cash flows that change because of the project, ignore sunk costs, and include opportunity costs and externalities when they are economically real.',
        keyPoints: [
          'NPV directly measures expected value creation.',
          'Sunk costs are excluded because they cannot be changed by the decision.',
          'Mutually exclusive projects should usually be ranked by NPV, not IRR alone.',
        ],
      },
      {
        title: 'Cost of Capital and Leverage',
        content:
          'The weighted average cost of capital blends required returns from debt and equity based on target capital structure. Debt is tax advantaged because interest is usually tax deductible, but too much debt raises financial distress risk and can reduce flexibility.\n\nOperating leverage comes from fixed operating costs. Financial leverage comes from fixed financing costs. Both magnify outcomes, making upside better and downside worse.',
        keyPoints: [
          'Use market-value weights when estimating WACC.',
          'After-tax cost of debt reflects the tax shield on interest.',
          'Higher leverage can raise expected ROE while also raising equity risk.',
        ],
      },
      {
        title: 'Working Capital and Governance',
        content:
          'Working capital policy balances liquidity against return. More cash, inventory, and receivables can reduce operating risk, but they tie up capital. Supplier financing and short-term borrowing can improve liquidity if matched to operating cycles.\n\nCorporate governance aligns managers with capital providers. Board independence, shareholder voting rights, audit quality, compensation design, and transparent reporting all affect agency risk.',
        keyPoints: [
          'Aggressive working capital policy uses less liquidity buffer and more short-term financing.',
          'Good governance reduces agency costs and can lower required returns.',
          'Liquidity management should match the cash conversion cycle.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Net Present Value',
        latex: 'NPV = \\sum_{t=0}^{n}\\frac{CF_t}{(1+r)^t}',
        description: 'Value created after discounting all incremental cash flows.',
      },
      {
        name: 'WACC',
        latex: 'WACC = w_d r_d(1-T) + w_e r_e',
        description: 'Weighted average required return for debt and equity capital.',
      },
      {
        name: 'Operating Leverage',
        latex: 'DOL = \\frac{\\%\\Delta EBIT}{\\%\\Delta Sales}',
        description: 'Sensitivity of operating income to sales changes.',
      },
      {
        name: 'Cash Conversion Cycle',
        latex: 'CCC = DIO + DSO - DPO',
        description: 'Days cash is tied up in the operating cycle.',
      },
    ],
  },
  equity: {
    title: 'Equity Investments',
    weight: '11-14%',
    sections: [
      {
        title: 'Markets, Shares, and Orders',
        content:
          'Equity represents residual ownership. Common shares usually carry voting rights and variable dividends; preferred shares often have priority dividends but limited voting power. Markets connect buyers and sellers through quote-driven, order-driven, and brokered mechanisms.\n\nOrder instructions shape execution. A market order prioritizes speed, while a limit order controls price but may not execute. Liquidity improves when spreads are tight, depth is strong, and trading is resilient after order flow shocks.',
        keyPoints: [
          'Common shareholders are residual claimants after creditors and preferred shareholders.',
          'Limit orders trade execution certainty for price control.',
          'Indexes can be price-weighted, equal-weighted, or market-cap weighted.',
        ],
      },
      {
        title: 'Valuation Methods',
        content:
          'Equity valuation converts business expectations into price estimates. Dividend discount models work best for stable dividend payers. Free cash flow models are broader because they value cash available to capital providers or equity holders. Relative valuation compares price multiples to fundamentals and peers.\n\nEvery valuation method is only as good as its assumptions. Growth, reinvestment, margin durability, required return, and terminal value usually drive most of the result.',
        keyPoints: [
          'The Gordon Growth model requires the discount rate to exceed perpetual growth.',
          'Relative multiples should be compared against growth, risk, and profitability.',
          'Terminal assumptions often dominate long-horizon valuation.',
        ],
      },
      {
        title: 'Industry and Company Analysis',
        content:
          'Industry analysis explains the environment around a company. Competitive rivalry, supplier power, buyer power, substitutes, and barriers to entry shape returns on capital. Company analysis then asks whether strategy, management quality, assets, and financials can produce durable value.\n\nA strong business is not automatically a strong investment. Price matters, and expectations embedded in the current valuation must be compared with a realistic forecast.',
        keyPoints: [
          'High barriers to entry can protect returns on invested capital.',
          'Cyclical industries require normalized earnings analysis.',
          'A premium multiple must be supported by growth, quality, or risk advantages.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Gordon Growth Model',
        latex: 'P_0 = \\frac{D_1}{r-g}',
        description: 'Value of a constant-growth dividend stream.',
      },
      {
        name: 'Justified P/E',
        latex: 'P/E = \\frac{Payout\\ Ratio}{r-g}',
        description: 'Fundamental price-earnings multiple under stable growth.',
      },
      {
        name: 'Free Cash Flow to Equity',
        latex: 'FCFE = CFO - FCInv + Net\\ Borrowing',
        description: 'Cash flow available to common equity holders.',
      },
      {
        name: 'Market-Cap Weighted Return',
        latex: 'R_I = \\sum w_i R_i',
        description: 'Index return using beginning market capitalization weights.',
      },
    ],
  },
  'fixed-income': {
    title: 'Fixed Income',
    weight: '11-14%',
    sections: [
      {
        title: 'Bond Cash Flows and Yields',
        content:
          'A bond is a contract for future cash flows. The price is the present value of promised coupons and principal, discounted at rates that reflect time value and risk. If the coupon rate is below the market yield, the bond trades at a discount. If the coupon rate is above the market yield, it trades at a premium.\n\nYield measures answer different questions. Current yield focuses only on annual coupon relative to price. Yield to maturity is the single discount rate that equates price with all promised cash flows, assuming no default and reinvestment at that yield.',
        keyPoints: [
          'Bond prices and yields move inversely.',
          'A premium bond has coupon rate greater than market yield.',
          'YTM is a promised yield, not necessarily a realized return.',
        ],
      },
      {
        title: 'Duration and Convexity',
        content:
          'Duration approximates price sensitivity to yield changes. Modified duration estimates the percentage price change for a small yield change. Convexity improves the estimate because the price-yield relationship is curved, not a straight line.\n\nLonger maturity, lower coupon, and lower yield generally increase duration. Embedded options can change duration because cash flows may shift when rates move.',
        keyPoints: [
          'Modified duration turns a yield change into an approximate percentage price change.',
          'Positive convexity means price gains from falling rates are larger than price losses from equal rising rates.',
          'Callable bonds can show reduced upside when rates fall.',
        ],
      },
      {
        title: 'Credit Risk and Structure',
        content:
          'Credit analysis studies the issuer ability and willingness to pay. Spreads compensate investors for expected loss, downgrade risk, liquidity risk, and risk aversion. Senior secured debt usually has stronger recovery prospects than subordinated unsecured debt.\n\nStructured products repackage cash flows from asset pools into tranches. Tranching can change timing and credit exposure, but it does not remove the need to analyze collateral quality and structural protections.',
        keyPoints: [
          'Credit spread is yield above a comparable risk-free benchmark.',
          'Higher seniority and collateral generally improve recovery prospects.',
          'Securitization redistributes cash-flow risk across tranches.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Bond Price',
        latex: 'P = \\sum_{t=1}^{N}\\frac{C}{(1+y)^t}+\\frac{FV}{(1+y)^N}',
        description: 'Present value of coupon and principal cash flows.',
      },
      {
        name: 'Current Yield',
        latex: 'Current\\ Yield = \\frac{Annual\\ Coupon}{Price}',
        description: 'Income yield ignoring principal gain or loss.',
      },
      {
        name: 'Modified Duration',
        latex: 'D_{mod}=\\frac{D_{Mac}}{1+y/m}',
        description: 'Approximate percentage price sensitivity to yield changes.',
      },
      {
        name: 'Duration Price Change',
        latex: '\\%\\Delta P \\approx -D_{mod}\\Delta y',
        description: 'First-order bond price impact from a yield shock.',
      },
    ],
  },
  derivatives: {
    title: 'Derivatives',
    weight: '5-8%',
    sections: [
      {
        title: 'Contract Types and Payoffs',
        content:
          'Derivatives derive value from an underlying asset, rate, index, or event. Forwards and futures lock in a future transaction price. Options create asymmetric payoffs: the buyer has a right but not an obligation, while the seller has the obligation if exercised. Swaps exchange streams of cash flows.\n\nThe payoff diagram is often the fastest way to understand a derivative. Long forwards gain when the underlying rises; long puts gain when the underlying falls below the strike; long calls gain when the underlying rises above the strike.',
        keyPoints: [
          'Forwards are customized OTC contracts; futures are standardized and exchange traded.',
          'Option buyers pay premium for asymmetry.',
          'Swaps can transform floating exposure into fixed exposure or the reverse.',
        ],
      },
      {
        title: 'No-Arbitrage Pricing',
        content:
          'No-arbitrage pricing says equivalent cash-flow packages should have equivalent prices. A forward price reflects the spot price grown at financing cost and adjusted for benefits or costs of carry. Put-call parity links European calls, puts, stock, and a risk-free bond with the same strike and maturity.\n\nWhen parity relationships are violated beyond transaction costs, traders can construct offsetting positions that lock in a profit. In liquid markets, that pressure usually pushes prices back into alignment.',
        keyPoints: [
          'Forward price rises with financing cost and falls with income benefits from the asset.',
          'Put-call parity is a synthetic replication relationship.',
          'No-arbitrage prices are model anchors, not promises about future market prices.',
        ],
      },
      {
        title: 'Hedging Uses',
        content:
          'Derivatives are often used to reshape risk rather than speculate. A portfolio manager worried about equity downside can sell futures or buy puts. A borrower worried about rising rates can use swaps or caps. Hedge effectiveness depends on matching notional, timing, and risk drivers.\n\nBasis risk appears when the derivative and hedged exposure do not move perfectly together. A hedge can reduce the dominant risk while leaving residual exposure.',
        keyPoints: [
          'Short futures hedge price declines in the underlying exposure.',
          'Options hedge downside while preserving some upside.',
          'Basis risk is the mismatch between hedge instrument and hedged item.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Forward Price with Carry',
        latex: 'F_0 = S_0(1+r)^T',
        description: 'Simple no-income forward price with discrete compounding.',
      },
      {
        name: 'Put-Call Parity',
        latex: 'C + \\frac{X}{(1+r)^T} = P + S_0',
        description: 'European option parity with no dividends.',
      },
      {
        name: 'Call Option Payoff',
        latex: 'Payoff = max(0, S_T - X)',
        description: 'Expiration payoff to a long call.',
      },
      {
        name: 'Put Option Payoff',
        latex: 'Payoff = max(0, X - S_T)',
        description: 'Expiration payoff to a long put.',
      },
    ],
  },
  alternatives: {
    title: 'Alternative Investments',
    weight: '7-10%',
    sections: [
      {
        title: 'Alternative Asset Classes',
        content:
          'Alternative investments include asset classes and strategies outside traditional public equities and bonds. Real estate can provide income and inflation sensitivity. Private equity seeks active control or influence over private companies. Hedge funds use flexible trading mandates. Commodities, infrastructure, private credit, and natural resources each bring distinct return drivers.\n\nAlternatives often promise diversification, but the details matter. Illiquidity, leverage, appraisal methods, and fee structures can make risk harder to observe.',
        keyPoints: [
          'Alternatives often have lower liquidity than public securities.',
          'Reported volatility can be understated when assets are appraised infrequently.',
          'Diversification benefits depend on true economic exposure, not label alone.',
        ],
      },
      {
        title: 'Valuation and Fees',
        content:
          'Real estate valuation commonly uses net operating income and capitalization rates. Private equity valuation often uses comparable multiples, discounted cash flow, or transaction evidence. Hedge funds and private funds commonly report net asset value, but the reliability of NAV depends on observable inputs and valuation controls.\n\nFees are central. Management fees are usually charged on committed or invested capital, while performance fees reward gains above a benchmark or hurdle. Waterfalls specify how cash distributions are split.',
        keyPoints: [
          'Lower cap rates imply higher real estate values for a given NOI.',
          'A hurdle rate protects limited partners before carry is paid.',
          'Fee terms can materially change investor net returns.',
        ],
      },
      {
        title: 'Risk and Portfolio Role',
        content:
          'Alternative investments can add return sources, inflation exposure, or diversification, but they also introduce manager selection risk, liquidity constraints, leverage, operational risk, and valuation uncertainty. Due diligence is therefore part of the investment thesis, not a back-office formality.\n\nThe portfolio role should be explicit: income, growth, inflation hedge, crisis protection, or return enhancement. A vague allocation to alternatives can hide concentrated risk.',
        keyPoints: [
          'Lockups and gates can limit liquidity during stress.',
          'Leverage magnifies both gains and losses.',
          'Manager dispersion is often wider in private and hedge fund strategies.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Real Estate Value from Cap Rate',
        latex: 'Value = \\frac{NOI}{Cap\\ Rate}',
        description: 'Capitalizes stabilized net operating income.',
      },
      {
        name: 'Net Asset Value',
        latex: 'NAV = Assets - Liabilities',
        description: 'Fund or vehicle value before per-share division.',
      },
      {
        name: 'Management Fee',
        latex: 'Fee = Fee\\ Rate \\times Capital\\ Base',
        description: 'Recurring fee charged on committed, invested, or net asset capital.',
      },
      {
        name: 'Total Return',
        latex: 'R = \\frac{Income + Price\\ Change}{Beginning\\ Value}',
        description: 'Income and appreciation relative to starting value.',
      },
    ],
  },
  portfolio: {
    title: 'Portfolio Management',
    weight: '8-12%',
    sections: [
      {
        title: 'Risk, Return, and Diversification',
        content:
          'Portfolio management combines assets to meet objectives under constraints. Expected return is a weighted average, but portfolio risk depends on covariance, not just individual volatilities. Diversification works when assets do not move perfectly together.\n\nCorrelation is central. Adding a lower-return asset can improve the portfolio if it reduces risk enough. The efficient frontier contains portfolios that offer the highest expected return for each risk level.',
        keyPoints: [
          'Portfolio expected return is the weighted average of asset expected returns.',
          'Risk reduction depends on correlation and covariance.',
          'The efficient frontier excludes portfolios dominated by better risk-return combinations.',
        ],
      },
      {
        title: 'CAPM and Allocation',
        content:
          'The Capital Asset Pricing Model links expected return to systematic risk. Beta measures sensitivity to the market portfolio. In CAPM, investors are only compensated for non-diversifiable risk because diversifiable risk can be reduced in a broad portfolio.\n\nAsset allocation sets broad exposures. Security selection chooses instruments within those exposures. For many investors, allocation explains more outcome variation than individual security picks.',
        keyPoints: [
          'Beta above 1 means more market sensitivity than the market portfolio.',
          'The market risk premium is expected market return minus risk-free rate.',
          'Diversifiable risk is not rewarded in the CAPM framework.',
        ],
      },
      {
        title: 'Policy, Rebalancing, and Performance',
        content:
          'An investment policy statement records objectives, constraints, risk tolerance, time horizon, liquidity needs, tax considerations, and governance responsibilities. It turns vague preferences into a decision framework.\n\nPerformance evaluation compares outcomes with objectives and benchmarks. Attribution separates allocation, selection, and interaction effects so the investor can understand what drove active performance.',
        keyPoints: [
          'An IPS should be specific enough to guide decisions during stress.',
          'Rebalancing controls drift from target allocation.',
          'Attribution explains sources of relative performance.',
        ],
      },
    ],
    formulas: [
      {
        name: 'Portfolio Expected Return',
        latex: 'E(R_p)=\\sum w_iE(R_i)',
        description: 'Weighted average of component expected returns.',
      },
      {
        name: 'Two-Asset Portfolio Variance',
        latex: '\\sigma_p^2=w_1^2\\sigma_1^2+w_2^2\\sigma_2^2+2w_1w_2\\rho_{12}\\sigma_1\\sigma_2',
        description: 'Portfolio variance including correlation.',
      },
      {
        name: 'CAPM',
        latex: 'E(R_i)=R_f+\\beta_i(E(R_m)-R_f)',
        description: 'Expected return from systematic risk exposure.',
      },
      {
        name: 'Sharpe Ratio',
        latex: 'Sharpe=\\frac{R_p-R_f}{\\sigma_p}',
        description: 'Excess return per unit of total risk.',
      },
    ],
  },
};

export const cfaLevel1Quizzes = {
  economics: [
    q({
      id: 'econ-1',
      topic: 'economics',
      learningObjective: 'econ-lo1',
      question: 'If the absolute value of price elasticity of demand is greater than 1, demand is best described as:',
      options: ['Perfectly inelastic', 'Inelastic', 'Unit elastic', 'Elastic'],
      correct: 3,
      explanation:
        'Demand is elastic when the absolute value of price elasticity exceeds 1, meaning quantity demanded changes by a larger percentage than price.',
      formula: 'Price Elasticity of Demand',
      tags: ['elasticity', 'demand'],
    }),
    q({
      id: 'econ-2',
      topic: 'economics',
      learningObjective: 'econ-lo2',
      question: 'Which expenditure component is directly included in GDP under the expenditure approach?',
      options: ['Transfer payments', 'Intermediate goods', 'Net exports', 'Capital gains'],
      correct: 2,
      explanation:
        'The expenditure approach is GDP = C + I + G + (X - M). Net exports are exports minus imports and are included directly.',
      formula: 'GDP Expenditure Approach',
      tags: ['gdp', 'macroeconomics'],
    }),
    q({
      id: 'econ-3',
      topic: 'economics',
      learningObjective: 'econ-lo2',
      question: 'An economy operating near full capacity receives aggressive fiscal stimulus. The most likely near-term risk is:',
      options: ['Deflation from lower demand', 'Higher inflation pressure', 'A lower price level from crowding in', 'Elimination of the output gap without price effects'],
      correct: 1,
      explanation:
        'When spare capacity is limited, additional demand is more likely to show up as inflation pressure than real output growth.',
      difficulty: 'intermediate',
      tags: ['fiscal-policy', 'inflation'],
    }),
    q({
      id: 'econ-4',
      topic: 'economics',
      learningObjective: 'econ-lo3',
      question: 'If the domestic currency appreciates, domestic consumers will generally find imports:',
      options: ['More expensive', 'Cheaper', 'Unaffected in local-currency terms', 'Unavailable'],
      correct: 1,
      explanation:
        'A stronger domestic currency buys more foreign currency, lowering the local-currency cost of foreign goods, all else equal.',
      tags: ['currency', 'trade'],
    }),
    q({
      id: 'econ-5',
      topic: 'economics',
      learningObjective: 'econ-lo1',
      question: 'A binding price ceiling set below equilibrium price most directly creates:',
      options: ['A surplus', 'A shortage', 'Higher producer surplus for all sellers', 'No change in quantity traded'],
      correct: 1,
      explanation:
        'A price ceiling below equilibrium keeps price too low, so quantity demanded exceeds quantity supplied and a shortage results.',
      difficulty: 'intermediate',
      tags: ['price-controls', 'markets'],
    }),
  ],
  fsa: [
    q({
      id: 'fsa-1',
      topic: 'fsa',
      learningObjective: 'fsa-lo1',
      question: 'Which statement best captures the basic balance sheet identity?',
      options: ['Assets = Revenue - Expenses', 'Assets = Liabilities + Equity', 'Equity = Assets + Liabilities', 'Cash Flow = Net Income + Dividends'],
      correct: 1,
      explanation: 'The accounting equation is Assets = Liabilities + Equity. Every balance sheet must satisfy this identity.',
      formula: 'Accounting Equation',
      tags: ['balance-sheet'],
    }),
    q({
      id: 'fsa-2',
      topic: 'fsa',
      learningObjective: 'fsa-lo2',
      question: 'In DuPont analysis, an increase in ROE caused only by a higher equity multiplier indicates:',
      options: ['Higher profit margin', 'Higher asset turnover', 'Higher financial leverage', 'Lower tax burden'],
      correct: 2,
      explanation:
        'The equity multiplier is assets divided by equity. A higher multiplier means greater financial leverage, which can increase ROE while increasing risk.',
      formula: 'DuPont ROE',
      difficulty: 'intermediate',
      tags: ['dupont', 'roe'],
    }),
    q({
      id: 'fsa-3',
      topic: 'fsa',
      learningObjective: 'fsa-lo1',
      question: 'Under accrual accounting, revenue is generally recognized when it is:',
      options: ['Collected in cash', 'Earned and measurable', 'Budgeted by management', 'Approved by tax authorities'],
      correct: 1,
      explanation:
        'Accrual accounting recognizes revenue when earned and reasonably measurable, not necessarily when cash is collected.',
      tags: ['accruals', 'revenue'],
    }),
    q({
      id: 'fsa-4',
      topic: 'fsa',
      learningObjective: 'fsa-lo3',
      question: 'In a rising price environment, FIFO compared with LIFO typically reports:',
      options: ['Lower ending inventory and lower gross profit', 'Higher ending inventory and higher gross profit', 'Higher COGS and lower taxes in every jurisdiction', 'No difference in reported inventory'],
      correct: 1,
      explanation:
        'FIFO leaves newer, higher-cost inventory on the balance sheet and sends older, lower costs to COGS, increasing gross profit relative to LIFO.',
      difficulty: 'advanced',
      tags: ['inventory', 'fifo-lifo'],
    }),
    q({
      id: 'fsa-5',
      topic: 'fsa',
      learningObjective: 'fsa-lo2',
      question: 'A current ratio of 2.0 means:',
      options: ['Current liabilities are twice current assets', 'Current assets are twice current liabilities', 'Net income is twice cash flow', 'Debt is twice equity'],
      correct: 1,
      explanation:
        'Current ratio = current assets / current liabilities. A value of 2.0 means current assets equal two times current liabilities.',
      formula: 'Current Ratio',
      tags: ['liquidity', 'ratios'],
    }),
  ],
  corporate: [
    q({
      id: 'corp-1',
      topic: 'corporate',
      learningObjective: 'corp-lo1',
      question: 'For an independent project, the clearest signal that the project is expected to create value is:',
      options: ['Negative NPV', 'Positive NPV', 'Payback longer than project life', 'Accounting profit equal to zero'],
      correct: 1,
      explanation:
        'Positive NPV means discounted incremental benefits exceed discounted costs, increasing firm value.',
      formula: 'Net Present Value',
      tags: ['npv', 'capital-budgeting'],
    }),
    q({
      id: 'corp-2',
      topic: 'corporate',
      learningObjective: 'corp-lo2',
      question: 'When estimating WACC, the cost of debt is usually adjusted for taxes because:',
      options: ['Dividends are tax deductible', 'Interest expense is commonly tax deductible', 'Equity has no risk', 'Debt principal is expensed immediately'],
      correct: 1,
      explanation:
        'Interest deductibility creates a tax shield, so the after-tax cost of debt is rd x (1 - tax rate).',
      formula: 'WACC',
      tags: ['wacc', 'tax-shield'],
    }),
    q({
      id: 'corp-3',
      topic: 'corporate',
      learningObjective: 'corp-lo1',
      question: 'Which cash flow should be excluded from project analysis?',
      options: ['Opportunity cost of using an owned asset', 'Incremental working capital need', 'Sunk cost already incurred', 'After-tax salvage value'],
      correct: 2,
      explanation:
        'Sunk costs have already occurred and cannot be changed by the accept/reject decision, so they are excluded.',
      difficulty: 'intermediate',
      tags: ['incremental-cash-flow'],
    }),
    q({
      id: 'corp-4',
      topic: 'corporate',
      learningObjective: 'corp-lo3',
      question: 'The cash conversion cycle is shortened by:',
      options: ['Collecting receivables faster', 'Holding inventory longer', 'Paying suppliers sooner', 'Increasing days sales outstanding'],
      correct: 0,
      explanation:
        'Collecting receivables faster reduces DSO, which lowers CCC = DIO + DSO - DPO.',
      formula: 'Cash Conversion Cycle',
      tags: ['working-capital'],
    }),
    q({
      id: 'corp-5',
      topic: 'corporate',
      learningObjective: 'corp-lo2',
      question: 'Higher operating leverage most directly means operating income is more sensitive to changes in:',
      options: ['Sales', 'Tax rates only', 'Dividend payout', 'Book value of equity'],
      correct: 0,
      explanation:
        'Operating leverage comes from fixed operating costs, making EBIT more sensitive to sales changes.',
      formula: 'Operating Leverage',
      difficulty: 'intermediate',
      tags: ['leverage'],
    }),
  ],
  equity: [
    q({
      id: 'eq-1',
      topic: 'equity',
      learningObjective: 'eq-lo1',
      question: 'A market order prioritizes:',
      options: ['Execution speed', 'Maximum price control', 'Avoiding all trading costs', 'Voting rights'],
      correct: 0,
      explanation:
        'A market order seeks immediate execution at the best available price, giving up exact price control.',
      tags: ['orders', 'market-structure'],
    }),
    q({
      id: 'eq-2',
      topic: 'equity',
      learningObjective: 'eq-lo2',
      question: 'A stock is expected to pay a dividend of 2 next year, with required return of 10% and perpetual growth of 4%. Its Gordon Growth value is:',
      options: ['20.00', '25.00', '33.33', '50.00'],
      correct: 2,
      explanation:
        'P0 = D1 / (r - g) = 2 / (0.10 - 0.04) = 33.33.',
      formula: 'Gordon Growth Model',
      difficulty: 'intermediate',
      tags: ['ddm', 'valuation'],
    }),
    q({
      id: 'eq-3',
      topic: 'equity',
      learningObjective: 'eq-lo2',
      question: 'Relative valuation using P/E multiples should be interpreted alongside:',
      options: ['Only share count', 'Growth, profitability, and risk differences', 'Historical stock ticker symbols', 'Coupon payment dates'],
      correct: 1,
      explanation:
        'A higher P/E may be justified by higher growth, better profitability, lower risk, or accounting differences.',
      difficulty: 'intermediate',
      tags: ['multiples', 'valuation'],
    }),
    q({
      id: 'eq-4',
      topic: 'equity',
      learningObjective: 'eq-lo3',
      question: 'High barriers to entry usually support:',
      options: ['Lower sustainable returns', 'More durable industry profitability', 'No need for valuation work', 'Guaranteed dividend growth'],
      correct: 1,
      explanation:
        'Barriers to entry can protect existing firms from competition, supporting more durable returns on capital.',
      tags: ['industry-analysis'],
    }),
    q({
      id: 'eq-5',
      topic: 'equity',
      learningObjective: 'eq-lo1',
      question: 'Common shareholders are best described as:',
      options: ['Senior creditors', 'Residual owners', 'Tax authorities', 'Guaranteed dividend recipients'],
      correct: 1,
      explanation:
        'Common equity is the residual ownership claim after creditors and higher-priority claims.',
      tags: ['equity-securities'],
    }),
  ],
  'fixed-income': [
    q({
      id: 'fi-1',
      topic: 'fixed-income',
      learningObjective: 'fi-lo1',
      question: 'When market yields rise, the price of a plain fixed-rate bond generally:',
      options: ['Rises', 'Falls', 'Stays fixed at par', 'Equals accrued interest'],
      correct: 1,
      explanation:
        'Bond prices and yields move inversely because existing fixed cash flows are discounted at a higher rate.',
      tags: ['yield', 'bond-pricing'],
    }),
    q({
      id: 'fi-2',
      topic: 'fixed-income',
      learningObjective: 'fi-lo1',
      question: 'A bond with coupon rate above its market yield will most likely trade:',
      options: ['At a discount', 'At par only', 'At a premium', 'With zero duration'],
      correct: 2,
      explanation:
        'If coupon rate exceeds required yield, the coupon stream is attractive and the bond trades above par.',
      difficulty: 'intermediate',
      tags: ['premium-discount'],
    }),
    q({
      id: 'fi-3',
      topic: 'fixed-income',
      learningObjective: 'fi-lo2',
      question: 'A bond has modified duration of 6. If yield rises by 0.50%, the approximate price change is:',
      options: ['+3.0%', '-3.0%', '+0.30%', '-0.30%'],
      correct: 1,
      explanation:
        'Approximate percentage price change = -Dmod x change in yield = -6 x 0.005 = -0.03, or -3.0%.',
      formula: 'Duration Price Change',
      difficulty: 'intermediate',
      tags: ['duration'],
    }),
    q({
      id: 'fi-4',
      topic: 'fixed-income',
      learningObjective: 'fi-lo3',
      question: 'Credit spread is best described as:',
      options: ['Coupon divided by price', 'Yield above a comparable risk-free benchmark', 'Principal repayment speed', 'Duration divided by convexity'],
      correct: 1,
      explanation:
        'Credit spread is the extra yield over a comparable risk-free or benchmark rate for bearing credit and related risks.',
      tags: ['credit-risk'],
    }),
    q({
      id: 'fi-5',
      topic: 'fixed-income',
      learningObjective: 'fi-lo2',
      question: 'Positive convexity means that for equal-sized yield changes:',
      options: ['Price gains when yields fall exceed price losses when yields rise', 'Duration is always zero', 'Bond price is unrelated to yield', 'Coupon payments stop'],
      correct: 0,
      explanation:
        'With positive convexity, the price-yield curve bends favorably: upside from falling yields is larger than downside from rising yields.',
      difficulty: 'advanced',
      tags: ['convexity'],
    }),
  ],
  derivatives: [
    q({
      id: 'deriv-1',
      topic: 'derivatives',
      learningObjective: 'deriv-lo1',
      question: 'The payoff to a long call option at expiration is:',
      options: ['max(0, X - ST)', 'max(0, ST - X)', 'ST - F0', 'Coupon / price'],
      correct: 1,
      explanation:
        'A long call benefits when the underlying price at expiration exceeds the strike: max(0, ST - X).',
      formula: 'Call Option Payoff',
      tags: ['options', 'payoffs'],
    }),
    q({
      id: 'deriv-2',
      topic: 'derivatives',
      learningObjective: 'deriv-lo2',
      question: 'Ignoring income and using discrete compounding, the no-arbitrage forward price is closest to:',
      options: ['S0 / (1 + r)^T', 'S0(1 + r)^T', 'Strike minus premium', 'Coupon times duration'],
      correct: 1,
      explanation:
        'Without income or storage costs, the forward price is the spot price grown at the financing rate: F0 = S0(1 + r)^T.',
      formula: 'Forward Price with Carry',
      difficulty: 'intermediate',
      tags: ['forward-pricing'],
    }),
    q({
      id: 'deriv-3',
      topic: 'derivatives',
      learningObjective: 'deriv-lo3',
      question: 'An investor holding a broad equity portfolio who wants to reduce downside exposure could most directly:',
      options: ['Buy equity index puts', 'Buy more of the same equity index', 'Sell Treasury bills', 'Ignore hedge notional'],
      correct: 0,
      explanation:
        'Buying puts provides downside protection while preserving some upside, though the investor pays option premium.',
      tags: ['hedging', 'options'],
    }),
    q({
      id: 'deriv-4',
      topic: 'derivatives',
      learningObjective: 'deriv-lo1',
      question: 'Compared with forwards, futures contracts are generally:',
      options: ['More customized and never marked to market', 'Standardized and exchange traded', 'Only used for private equity', 'Always options'],
      correct: 1,
      explanation:
        'Futures are standardized exchange-traded contracts with clearinghouse mechanics and daily marking to market.',
      tags: ['futures', 'contracts'],
    }),
    q({
      id: 'deriv-5',
      topic: 'derivatives',
      learningObjective: 'deriv-lo2',
      question: 'Put-call parity is best described as:',
      options: ['A relationship linking equivalent European option and underlying positions', 'A guarantee that calls and puts have equal prices', 'An accounting ratio', 'A bond covenant'],
      correct: 0,
      explanation:
        'Put-call parity links calls, puts, the underlying, and a risk-free bond when cash flows are equivalent under no arbitrage.',
      formula: 'Put-Call Parity',
      difficulty: 'intermediate',
      tags: ['parity', 'options'],
    }),
  ],
  alternatives: [
    q({
      id: 'alt-1',
      topic: 'alternatives',
      learningObjective: 'alt-lo1',
      question: 'Which feature is most typical of many alternative investments compared with public equities?',
      options: ['Daily liquidity in all cases', 'Lower liquidity and more complex valuation', 'No manager selection risk', 'Guaranteed returns'],
      correct: 1,
      explanation:
        'Alternatives often involve illiquidity, appraisal-based valuation, complex fees, and greater due diligence needs.',
      tags: ['asset-classes', 'liquidity'],
    }),
    q({
      id: 'alt-2',
      topic: 'alternatives',
      learningObjective: 'alt-lo2',
      question: 'A property with NOI of 1,000,000 and cap rate of 5% has an indicated value of:',
      options: ['5,000,000', '20,000,000', '50,000', '1,050,000'],
      correct: 1,
      explanation:
        'Value = NOI / cap rate = 1,000,000 / 0.05 = 20,000,000.',
      formula: 'Real Estate Value from Cap Rate',
      difficulty: 'intermediate',
      tags: ['real-estate', 'valuation'],
    }),
    q({
      id: 'alt-3',
      topic: 'alternatives',
      learningObjective: 'alt-lo3',
      question: 'Infrequent appraisal of private assets can make reported volatility appear:',
      options: ['Higher than economic volatility in every case', 'Lower than economic volatility due to smoothing', 'Exactly equal to public market volatility', 'Negative'],
      correct: 1,
      explanation:
        'Appraisal smoothing can delay recognition of price changes, making reported volatility look artificially low.',
      difficulty: 'advanced',
      tags: ['appraisal', 'risk'],
    }),
    q({
      id: 'alt-4',
      topic: 'alternatives',
      learningObjective: 'alt-lo2',
      question: 'A hurdle rate in a private fund fee structure is designed to:',
      options: ['Eliminate all management fees', 'Set a minimum return before performance fees are paid', 'Guarantee public market liquidity', 'Measure bond duration'],
      correct: 1,
      explanation:
        'A hurdle rate requires investors to receive a minimum return before the manager earns incentive compensation.',
      tags: ['fees', 'private-equity'],
    }),
    q({
      id: 'alt-5',
      topic: 'alternatives',
      learningObjective: 'alt-lo1',
      question: 'Commodity returns are most directly linked to:',
      options: ['Only dividend payout ratios', 'Spot price changes, collateral return, and roll yield', 'Book value of common equity only', 'Coupon amortization'],
      correct: 1,
      explanation:
        'Commodity investment returns commonly reflect spot price movement, collateral yield, and roll yield from futures curve exposure.',
      difficulty: 'intermediate',
      tags: ['commodities'],
    }),
  ],
  portfolio: [
    q({
      id: 'pm-1',
      topic: 'portfolio',
      learningObjective: 'pm-lo1',
      question: 'Portfolio expected return is calculated as:',
      options: ['The lowest asset return', 'The weighted average of component expected returns', 'The sum of asset volatilities', 'The risk-free rate only'],
      correct: 1,
      explanation:
        'Expected portfolio return is the weighted average of asset expected returns: E(Rp) = sum wi E(Ri).',
      formula: 'Portfolio Expected Return',
      tags: ['expected-return'],
    }),
    q({
      id: 'pm-2',
      topic: 'portfolio',
      learningObjective: 'pm-lo1',
      question: 'Diversification benefit is strongest when asset returns have:',
      options: ['Perfect positive correlation', 'Lower or negative correlation', 'The same ticker', 'Identical risk and return in every state'],
      correct: 1,
      explanation:
        'Lower correlation reduces covariance, allowing combined portfolio risk to fall below a simple weighted average of individual risks.',
      tags: ['diversification', 'correlation'],
    }),
    q({
      id: 'pm-3',
      topic: 'portfolio',
      learningObjective: 'pm-lo2',
      question: 'Using CAPM, if Rf = 3%, beta = 1.2, and expected market return = 8%, expected return is:',
      options: ['6.0%', '8.0%', '9.0%', '12.6%'],
      correct: 2,
      explanation:
        'E(Ri) = 3% + 1.2 x (8% - 3%) = 3% + 6% = 9%.',
      formula: 'CAPM',
      difficulty: 'intermediate',
      tags: ['capm', 'beta'],
    }),
    q({
      id: 'pm-4',
      topic: 'portfolio',
      learningObjective: 'pm-lo3',
      question: 'An investment policy statement is most useful because it:',
      options: ['Eliminates market risk', 'Documents objectives and constraints before decisions are stressed', 'Guarantees benchmark outperformance', 'Replaces portfolio monitoring'],
      correct: 1,
      explanation:
        'An IPS records objectives, constraints, governance, and risk tolerance so decisions remain disciplined.',
      tags: ['ips', 'governance'],
    }),
    q({
      id: 'pm-5',
      topic: 'portfolio',
      learningObjective: 'pm-lo2',
      question: 'In CAPM, beta measures:',
      options: ['Total standalone volatility', 'Sensitivity to market movements', 'Accounting leverage only', 'Dividend payout stability'],
      correct: 1,
      explanation:
        'Beta measures systematic risk: the sensitivity of an asset return to market portfolio return.',
      tags: ['beta', 'capm'],
    }),
  ],
};
