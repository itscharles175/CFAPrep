import { cfaLevel1Content, cfaLevel1Objectives, cfaLevel1Quizzes } from './cfaLevel1Expansion';

const coreCfaContent = {
  ethics: {
    title: 'Ethics & Professional Standards',
    weight: '15-20%',
    sections: [
      {
        title: 'Code of Ethics',
        content: `The CFA Institute Code of Ethics establishes the framework for ethical conduct expected of all CFA charterholders and candidates. It reflects the profession's commitment to integrity and the public interest.

Members and candidates must:
• Act with integrity, competence, diligence, respect, and in an ethical manner with the public, clients, prospective clients, employers, employees, and colleagues.
• Place the integrity of the investment profession and the interests of clients above their own personal interests.
• Use reasonable care and exercise independent professional judgment.
• Practice and encourage others to practice in a professional and ethical manner.
• Promote the integrity and viability of the global capital markets for the ultimate benefit of society.
• Maintain and improve their professional competence.`,
        keyPoints: [
          'The Code applies to all CFA members and candidates globally',
          'Client interests always take priority over personal interests',
          'Independent judgment must not be compromised',
          'Continuous professional development is mandatory',
        ],
      },
      {
        title: 'Standards of Professional Conduct',
        content: `The Standards of Professional Conduct are organized into seven categories, each containing specific sub-standards:

**Standard I: Professionalism**
(A) Knowledge of the Law — Members must understand and comply with applicable laws, rules, and regulations. In cases of conflict, follow the stricter law/regulation.
(B) Independence and Objectivity — Maintain independence and objectivity in professional activities. Do not offer, solicit, or accept gifts that could compromise judgment.
(C) Misrepresentation — Do not knowingly make any misrepresentation relating to investment analysis, recommendations, or actions.
(D) Misconduct — Do not engage in any professional conduct involving dishonesty, fraud, or deceit.

**Standard II: Integrity of Capital Markets**
(A) Material Nonpublic Information — Do not act or cause others to act on material nonpublic information (insider trading).
(B) Market Manipulation — Do not engage in practices that distort prices or artificially inflate trading volume.

**Standard III: Duties to Clients**
(A) Loyalty, Prudence, and Care — Act for the benefit of clients with loyalty, reasonable care, and prudent judgment.
(B) Fair Dealing — Deal fairly and objectively with all clients in disseminating recommendations and taking investment actions.
(C) Suitability — Ensure investment recommendations are suitable for the client's financial situation and objectives.
(D) Performance Presentation — Present performance information fairly, accurately, and completely.
(E) Preservation of Confidentiality — Keep client information confidential.`,
        keyPoints: [
          'Seven standards organized by duty (professionalism, clients, employer, etc.)',
          'Material nonpublic information must never be acted upon',
          'Fair dealing requires simultaneous dissemination to all clients',
          'Suitability analysis is required before making recommendations',
          'Mosaic Theory allows using non-material nonpublic information combined with public information',
        ],
      },
      {
        title: 'GIPS Standards',
        content: `The Global Investment Performance Standards (GIPS) are a set of standardized, industry-wide ethical principles that guide investment firms on how to calculate and present their investment results to prospective clients.

**Key Principles:**
• GIPS are voluntary but widely adopted — firms claim compliance to build trust.
• Composites must include all actual, fee-paying, discretionary portfolios.
• Performance must be calculated using time-weighted returns.
• Firms must present at least 5 years of GIPS-compliant history (or since inception if less).
• All actual fee-paying discretionary portfolios must be included in at least one composite.

**Verification:** GIPS verification is performed by an independent third party and applies to the entire firm. Verification is recommended but not required.`,
        keyPoints: [
          'GIPS are voluntary global standards for performance reporting',
          'Time-weighted returns must be used for performance calculation',
          'Composites group similar portfolios together for fair comparison',
          'Minimum 5 years of compliant history required',
          'Verification is firm-wide, not composite-specific',
        ],
      },
    ],
    formulas: [
      { name: 'Time-Weighted Return', latex: 'R_{TWR} = \\prod_{t=1}^{n}(1 + R_t) - 1', description: 'Geometrically links sub-period returns, removing the effect of cash flows' },
      { name: 'Money-Weighted Return', latex: 'PV_{outflows} = PV_{inflows}', description: 'The IRR that equates present value of cash inflows to outflows' },
    ],
  },
  'quant-methods': {
    title: 'Quantitative Methods',
    weight: '6-9%',
    sections: [
      {
        title: 'Time Value of Money',
        content: `The Time Value of Money (TVM) is the foundational concept in finance — a dollar today is worth more than a dollar in the future because of its earning potential.

**Present Value (PV):** The current worth of a future sum of money given a specified rate of return. Discounting is the process of finding PV.

**Future Value (FV):** The value of a current asset at a specified future date based on an assumed growth rate. Compounding is the process of finding FV.

**Annuities:** A series of equal payments or receipts occurring at regular intervals.
• Ordinary Annuity: Payments occur at the end of each period
• Annuity Due: Payments occur at the beginning of each period

**Perpetuity:** An annuity with infinite life — payments continue forever.`,
        keyPoints: [
          'TVM is the single most important concept in finance',
          'Compounding frequency significantly affects future value',
          'An annuity due is worth more than an ordinary annuity (earlier payments)',
          'Perpetuity value = Payment / Discount Rate',
          'Effective Annual Rate (EAR) accounts for compounding frequency',
        ],
      },
      {
        title: 'Statistical Concepts & Probability',
        content: `Statistics and probability form the quantitative backbone of investment analysis and risk assessment.

**Descriptive Statistics:**
• Measures of Central Tendency: Mean (arithmetic, geometric, harmonic), median, mode
• Measures of Dispersion: Range, variance, standard deviation, coefficient of variation
• Measures of Shape: Skewness (asymmetry) and kurtosis (tail thickness)

**Probability Concepts:**
• Unconditional Probability: P(A) — probability of event A occurring
• Conditional Probability: P(A|B) — probability of A given B has occurred
• Joint Probability: P(A ∩ B) — probability of both A and B occurring
• Bayes' Formula: Updates prior probabilities with new information

**Distributions:**
• Normal Distribution: Symmetric, bell-shaped, fully described by mean and standard deviation
• Lognormal Distribution: Commonly used for asset prices (cannot go negative)
• Student's t-Distribution: Used when population variance is unknown and sample size is small`,
        keyPoints: [
          'Geometric mean is always ≤ arithmetic mean (equality only when all values are identical)',
          'Standard deviation is in same units as data; variance is in squared units',
          'Normal distribution: 68-95-99.7 rule for 1, 2, 3 standard deviations',
          'Leptokurtic distributions have fat tails (excess kurtosis > 0)',
          'Bayes\' formula: P(A|B) = P(B|A) × P(A) / P(B)',
        ],
      },
      {
        title: 'Hypothesis Testing & Regression',
        content: `Hypothesis testing provides a framework for making statistical inferences about population parameters based on sample data.

**Hypothesis Testing Steps:**
1. State the null (H₀) and alternative (Hₐ) hypotheses
2. Select the appropriate test statistic
3. Specify the significance level (α)
4. State the decision rule (critical value or p-value approach)
5. Collect data, compute the test statistic
6. Make the statistical decision (reject or fail to reject H₀)

**Common Tests:**
• z-test: Known population variance, large samples
• t-test: Unknown population variance, small samples
• Chi-square test: Tests concerning variance
• F-test: Tests comparing two variances

**Linear Regression:**
Simple linear regression models the relationship between two variables: Y = b₀ + b₁X + ε
• b₀ = intercept, b₁ = slope coefficient
• R² = coefficient of determination (proportion of variance explained)
• Standard Error of Estimate (SEE) measures the accuracy of predictions`,
        keyPoints: [
          'Type I error (α): Rejecting a true null hypothesis',
          'Type II error (β): Failing to reject a false null hypothesis',
          'Power of a test = 1 - β (probability of correctly rejecting false H₀)',
          'Lower significance level → fewer Type I errors but more Type II errors',
          'R² ranges from 0 to 1; higher values indicate better fit',
        ],
      },
    ],
    formulas: [
      { name: 'Future Value', latex: 'FV = PV \\times (1 + r)^n', description: 'Compound a present value forward in time' },
      { name: 'Present Value', latex: 'PV = \\frac{FV}{(1 + r)^n}', description: 'Discount a future value back to today' },
      { name: 'PV of Annuity', latex: 'PV_{annuity} = PMT \\times \\frac{1 - (1+r)^{-n}}{r}', description: 'Present value of a series of equal payments' },
      { name: 'FV of Annuity', latex: 'FV_{annuity} = PMT \\times \\frac{(1+r)^{n} - 1}{r}', description: 'Future value of a series of equal payments' },
      { name: 'Perpetuity', latex: 'PV_{perpetuity} = \\frac{PMT}{r}', description: 'Value of infinite equal payments' },
      { name: 'EAR', latex: 'EAR = \\left(1 + \\frac{r_{stated}}{m}\\right)^m - 1', description: 'Effective annual rate from stated rate with m compounding periods' },
      { name: 'Variance', latex: '\\sigma^2 = \\frac{\\sum_{i=1}^{N}(X_i - \\mu)^2}{N}', description: 'Average of squared deviations from the mean' },
      { name: 'Sharpe Ratio', latex: 'S = \\frac{R_p - R_f}{\\sigma_p}', description: 'Risk-adjusted return measure using total risk' },
      { name: 'Bayes Formula', latex: 'P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}', description: 'Updates prior probability given new evidence' },
      { name: 'Coefficient of Variation', latex: 'CV = \\frac{\\sigma}{\\bar{X}}', description: 'Relative dispersion — risk per unit of return' },
    ],
  },
};

const coreCfaQuizzes = {
  ethics: [
    {
      id: 'eth-1',
      question: 'According to the CFA Institute Code of Ethics, members and candidates must place the interests of which group above their own personal interests?',
      options: [
        'Their employer',
        'Clients and the integrity of the investment profession',
        'Regulatory bodies',
        'Shareholders of their firm',
      ],
      correct: 1,
      explanation: 'The Code of Ethics specifically states that members must "place the integrity of the investment profession and the interests of clients above their own personal interests." This is a fundamental principle of the CFA ethical framework.',
      difficulty: 'foundation',
    },
    {
      id: 'eth-2',
      question: 'A CFA charterholder discovers that a local law permits a certain trading practice, but the CFA Institute Standards prohibit it. What should the charterholder do?',
      options: [
        'Follow the local law since it is the governing authority',
        'Follow whichever standard is less restrictive',
        'Follow the stricter of the two — in this case, the CFA Standards',
        'Report the discrepancy to the CFA Institute before taking action',
      ],
      correct: 2,
      explanation: 'Standard I(A) Knowledge of the Law requires members to comply with the more strict law, rule, or regulation. When a conflict exists between CFA Standards and local law, they must follow whichever is MORE restrictive.',
      difficulty: 'foundation',
    },
    {
      id: 'eth-3',
      question: 'An analyst receives a material nonpublic tip about an upcoming merger from a company insider. Under the CFA Standards, which action is MOST appropriate?',
      options: [
        'Trade on the information but only for client accounts',
        'Share the information only with the compliance department',
        'Do not trade on or share the information and report the contact to compliance',
        'Wait 24 hours for the information to become public, then trade',
      ],
      correct: 2,
      explanation: 'Standard II(A) Material Nonpublic Information prohibits acting or causing others to act on material nonpublic information. The analyst should not trade, not share the info, and report the contact to their firm\'s compliance department.',
      difficulty: 'intermediate',
    },
    {
      id: 'eth-4',
      question: 'Under GIPS, how must a firm calculate investment performance?',
      options: [
        'Using money-weighted returns only',
        'Using time-weighted returns',
        'Using either method at the firm\'s discretion',
        'Using simple returns for periods under one year',
      ],
      correct: 1,
      explanation: 'GIPS requires the use of time-weighted returns because they remove the distorting effects of external cash flows, providing a more accurate measure of the investment manager\'s skill.',
      difficulty: 'intermediate',
    },
    {
      id: 'eth-5',
      question: 'Which of the following is MOST LIKELY a violation of Standard III(B) Fair Dealing?',
      options: [
        'Giving different investment advice to clients with different risk profiles',
        'Providing a new buy recommendation to premium clients 24 hours before other clients',
        'Charging higher fees to institutional clients for customized research',
        'Allocating oversubscribed IPO shares proportionally across all participating accounts',
      ],
      correct: 1,
      explanation: 'Fair Dealing requires that investment recommendations be disseminated to all clients simultaneously. Providing recommendations to premium clients before others violates this standard, regardless of the fee structure.',
      difficulty: 'advanced',
    },
    {
      id: 'eth-6',
      question: 'The Mosaic Theory allows an analyst to use:',
      options: [
        'Material nonpublic information combined with public information to make recommendations',
        'Non-material nonpublic information combined with public information to reach investment conclusions',
        'Only publicly available information for all investment decisions',
        'Insider information if it is obtained through legitimate research channels',
      ],
      correct: 1,
      explanation: 'The Mosaic Theory permits analysts to combine non-material nonpublic information (e.g., insights from company visits, expert opinions) with public information to form investment conclusions. The key requirement is that individual pieces of nonpublic info must be non-material.',
      difficulty: 'advanced',
    },
  ],
  'quant-methods': [
    {
      id: 'qm-1',
      question: 'An investor deposits $10,000 today at 8% annual interest compounded quarterly. What is the future value after 5 years?',
      options: [
        '$14,693.28',
        '$14,802.44',
        '$14,859.47',
        '$14,918.25',
      ],
      correct: 2,
      explanation: 'FV = PV × (1 + r/m)^(m×n) = $10,000 × (1 + 0.08/4)^(4×5) = $10,000 × (1.02)^20 = $10,000 × 1.485947 = $14,859.47. With quarterly compounding, we use r/4 for the periodic rate and 4×5=20 for total periods.',
      difficulty: 'foundation',
    },
    {
      id: 'qm-2',
      question: 'A stock has annual returns of 15%, -10%, 20%, and 8% over four years. What is the geometric mean return?',
      options: [
        '8.25%',
        '7.78%',
        '7.91%',
        '8.00%',
      ],
      correct: 2,
      explanation: 'Geometric mean = [(1.15)(0.90)(1.20)(1.08)]^(1/4) - 1 = [1.34136]^(0.25) - 1 = 1.0761 - 1 ≈ 7.61%. The geometric mean is always less than or equal to the arithmetic mean and better represents compound growth.',
      difficulty: 'intermediate',
    },
    {
      id: 'qm-3',
      question: 'For a normal distribution with a mean of 10% and a standard deviation of 5%, what is the approximate probability that the return will fall between 0% and 20%?',
      options: [
        '68.27%',
        '90.00%',
        '95.44%',
        '99.74%',
      ],
      correct: 2,
      explanation: '0% is 2 standard deviations below the mean (10% - 2×5% = 0%), and 20% is 2 standard deviations above (10% + 2×5% = 20%). By the empirical rule, approximately 95.44% of observations fall within ±2 standard deviations.',
      difficulty: 'intermediate',
    },
    {
      id: 'qm-4',
      question: 'What is the present value of a perpetuity paying $500 per year if the discount rate is 8%?',
      options: [
        '$4,000',
        '$5,000',
        '$6,250',
        '$62,500',
      ],
      correct: 2,
      explanation: 'PV of perpetuity = PMT / r = $500 / 0.08 = $6,250. A perpetuity is an infinite stream of equal payments, and its present value is simply the payment divided by the discount rate.',
      difficulty: 'foundation',
    },
    {
      id: 'qm-5',
      question: 'In hypothesis testing, a Type II error occurs when:',
      options: [
        'The null hypothesis is rejected when it is true',
        'The null hypothesis is not rejected when it is false',
        'The significance level is set too high',
        'The test statistic falls in the rejection region',
      ],
      correct: 1,
      explanation: 'A Type II error (β) is failing to reject a false null hypothesis — essentially missing a real effect. Type I error (α) is rejecting a true null. The power of a test (1-β) is the probability of correctly rejecting a false null.',
      difficulty: 'intermediate',
    },
    {
      id: 'qm-6',
      question: 'A stated annual interest rate of 12% compounded monthly corresponds to an effective annual rate (EAR) closest to:',
      options: [
        '12.00%',
        '12.36%',
        '12.55%',
        '12.68%',
      ],
      correct: 3,
      explanation: 'EAR = (1 + r/m)^m - 1 = (1 + 0.12/12)^12 - 1 = (1.01)^12 - 1 = 1.12683 - 1 = 12.68%. The EAR is always greater than the stated rate when compounding occurs more than once per year.',
      difficulty: 'foundation',
    },
  ],
};

const coreCfaObjectives = {
  ethics: [
    {
      id: 'eth-lo1',
      domain: 'cfa',
      topic: 'ethics',
      title: 'Apply the Code and Standards',
      description: 'Identify duties to clients, employers, markets, and the investment profession.',
      weight: '15-20%',
      tags: ['ethics', 'standards'],
    },
    {
      id: 'eth-lo2',
      domain: 'cfa',
      topic: 'ethics',
      title: 'Evaluate conflicts, fair dealing, and material information',
      description: 'Resolve professional conduct cases involving conflicts, priority, fair dealing, and MNPI.',
      weight: '15-20%',
      tags: ['conflicts', 'fair-dealing', 'mnpi'],
    },
    {
      id: 'eth-lo3',
      domain: 'cfa',
      topic: 'ethics',
      title: 'Interpret performance presentation standards',
      description: 'Explain GIPS concepts, time-weighted returns, composites, and firm-wide presentation integrity.',
      weight: '15-20%',
      tags: ['gips', 'performance'],
    },
  ],
  'quant-methods': [
    {
      id: 'qm-lo1',
      domain: 'cfa',
      topic: 'quant-methods',
      title: 'Solve time value of money problems',
      description: 'Calculate present value, future value, annuities, perpetuities, and effective annual rates.',
      weight: '6-9%',
      tags: ['tvm', 'rates'],
    },
    {
      id: 'qm-lo2',
      domain: 'cfa',
      topic: 'quant-methods',
      title: 'Apply probability and statistics',
      description: 'Use distributions, descriptive statistics, probability rules, and risk-adjusted measures.',
      weight: '6-9%',
      tags: ['statistics', 'probability'],
    },
    {
      id: 'qm-lo3',
      domain: 'cfa',
      topic: 'quant-methods',
      title: 'Interpret hypothesis tests and regression',
      description: 'Connect test statistics, decision rules, errors, power, and regression fit measures.',
      weight: '6-9%',
      tags: ['hypothesis-testing', 'regression'],
    },
  ],
};

const coreQuestionMetadata = {
  ethics: [
    { learningObjective: 'eth-lo1', tags: ['code-of-ethics'], errorCategories: ['ethics-judgment', 'concept', 'misread', 'none'] },
    { learningObjective: 'eth-lo1', tags: ['knowledge-of-law'], errorCategories: ['ethics-judgment', 'concept', 'misread', 'none'] },
    { learningObjective: 'eth-lo2', tags: ['mnpi'], errorCategories: ['ethics-judgment', 'concept', 'misread', 'none'] },
    { learningObjective: 'eth-lo3', formula: 'Time-Weighted Return', tags: ['gips', 'performance'], errorCategories: ['concept', 'formula', 'misread', 'none'] },
    { learningObjective: 'eth-lo2', tags: ['fair-dealing'], errorCategories: ['ethics-judgment', 'concept', 'misread', 'none'] },
    { learningObjective: 'eth-lo2', tags: ['mosaic-theory'], errorCategories: ['ethics-judgment', 'concept', 'misread', 'none'] },
  ],
  'quant-methods': [
    { learningObjective: 'qm-lo1', formula: 'Future Value', tags: ['tvm', 'compounding'] },
    { learningObjective: 'qm-lo2', tags: ['geometric-mean', 'returns'] },
    { learningObjective: 'qm-lo2', tags: ['normal-distribution'] },
    { learningObjective: 'qm-lo1', formula: 'Perpetuity', tags: ['perpetuity', 'valuation'] },
    { learningObjective: 'qm-lo3', tags: ['hypothesis-testing'] },
    { learningObjective: 'qm-lo1', formula: 'EAR', tags: ['effective-rate'] },
  ],
};

function enrichCoreQuestions(topic, questions) {
  return questions.map((question, index) => ({
    ...question,
    topic,
    learningObjective: coreQuestionMetadata[topic][index]?.learningObjective || `${topic}:general`,
    tags: coreQuestionMetadata[topic][index]?.tags || [],
    errorCategories: coreQuestionMetadata[topic][index]?.errorCategories || ['concept', 'calculation', 'formula', 'misread', 'none'],
    formula: coreQuestionMetadata[topic][index]?.formula,
  }));
}

export const cfaContent = {
  ...coreCfaContent,
  ...cfaLevel1Content,
};

export const cfaLearningObjectives = {
  ...coreCfaObjectives,
  ...cfaLevel1Objectives,
};

export const cfaQuizzes = {
  ethics: enrichCoreQuestions('ethics', coreCfaQuizzes.ethics),
  'quant-methods': enrichCoreQuestions('quant-methods', coreCfaQuizzes['quant-methods']),
  ...cfaLevel1Quizzes,
};

export const cfaQuestionBank = Object.values(cfaQuizzes).flat();
