export const excelContent = {
  fundamentals: {
    title: 'Excel Fundamentals',
    summary:
      'Build the habits that make financial models fast, readable, auditable, and hard to break.',
    outcomes: [
      'Use relative, absolute, and mixed references deliberately',
      'Separate inputs, calculations, checks, and outputs',
      'Apply formatting conventions that support review',
      'Add control checks before a model becomes complex',
    ],
    sections: [
      {
        title: 'Model Structure',
        content:
          'A clean model is not just attractive. It reduces review time and operational risk. Separate assumptions from calculations, keep units visible, and make every major output traceable to a small set of drivers.',
        keyPoints: [
          'Inputs should be visibly distinct from formulas',
          'Hardcodes inside calculation blocks are audit risk',
          'Every model needs balance checks and sanity checks',
        ],
      },
      {
        title: 'Reference Discipline',
        content:
          'Most spreadsheet errors are reference errors. Know when a cell should move, lock a row, lock a column, or remain fully fixed. Mixed references are essential for sensitivity tables and reusable schedules.',
        keyPoints: [
          '$A$1 locks row and column',
          'A$1 locks row only',
          '$A1 locks column only',
        ],
      },
      {
        title: 'Audit Trail Setup',
        content:
          'A reviewable workbook shows where assumptions enter, where formulas transform them, and where checks validate the result. The first audit layer should be built before the model grows.',
        keyPoints: [
          'Use a consistent color convention for inputs, formulas, and checks',
          'Keep control checks close to the schedules they validate',
          'Create a summary of unresolved review flags',
        ],
      },
    ],
    formulas: [
      { name: 'Absolute Reference', latex: '\\$A\\$1', description: 'Locks row and column when a formula is copied.' },
      { name: 'Balance Check', latex: '\\text{Check} = \\text{Assets} - \\text{Liabilities} - \\text{Equity}', description: 'Flags whether a balance sheet remains in balance.' },
      { name: 'Error Flag', latex: '=IF(ABS(check)<tolerance,"OK","Review")', description: 'Converts a numeric model check into an audit flag.' },
    ],
    exercise: 'reference-builder',
  },
  'advanced-formulas': {
    title: 'Advanced Formulas',
    summary:
      'Use modern lookup, filtering, aggregation, and dynamic-array patterns without creating fragile formula puzzles.',
    outcomes: [
      'Choose XLOOKUP, INDEX/MATCH, SUMIFS, or FILTER for the right job',
      'Use helper columns when they improve auditability',
      'Design formulas that survive row insertions and missing data',
      'Avoid volatile formulas unless the tradeoff is intentional',
    ],
    sections: [
      {
        title: 'Lookup Strategy',
        content:
          'XLOOKUP is readable and powerful, while INDEX/MATCH remains useful for flexible row-column retrieval. The best formula is not always the shortest; it is the one the next reviewer can trust.',
        keyPoints: [
          'Always define behavior for not-found cases',
          'Avoid approximate matching unless the lookup table is controlled',
          'Use structured references for table-driven models',
        ],
      },
      {
        title: 'Dynamic Arrays',
        content:
          'Dynamic arrays let formulas spill results across ranges. They are excellent for analysis layers, but production models still need clear boundaries so spilled output does not collide with downstream schedules.',
        keyPoints: [
          'FILTER, SORT, UNIQUE, and TAKE can replace manual helper ranges',
          'Spill ranges should be kept away from manual inputs',
          'LET can make complex formulas easier to read',
        ],
      },
      {
        title: 'Formula Review Pattern',
        content:
          'Advanced formulas should be reviewed for lookup direction, missing-value behavior, row insert resilience, and whether the formula is easier to audit than a helper column.',
        keyPoints: [
          'Define exact-match behavior explicitly',
          'Use structured references when source tables may grow',
          'Prefer readable formulas when the model will be reused',
        ],
      },
    ],
    formulas: [
      { name: 'XLOOKUP', latex: '\\text{XLOOKUP}(\\text{lookup value}, \\text{lookup array}, \\text{return array}, \\text{"Missing"})', description: 'Readable lookup with explicit missing-value behavior.' },
      { name: 'INDEX MATCH', latex: '\\text{INDEX}(\\text{return range}, \\text{MATCH}(\\text{id}, \\text{id range}, 0))', description: 'Flexible lookup pattern that separates position from returned value.' },
      { name: 'SUMIFS', latex: '\\text{SUMIFS}(\\text{amounts}, \\text{region}, \\text{"East"}, \\text{product}, \\text{"Credit"})', description: 'Aggregates values that satisfy multiple criteria.' },
      { name: 'FILTER', latex: '\\text{FILTER}(\\text{table}, \\text{condition}, \\text{"No rows"})', description: 'Returns a dynamic array of rows that meet a condition.' },
    ],
    exercise: 'formula-chooser',
  },
  'financial-functions': {
    title: 'Financial Functions',
    summary:
      'Use Excel finance functions correctly, especially when cash flow timing and sign conventions matter.',
    outcomes: [
      'Distinguish NPV from XNPV and IRR from XIRR',
      'Handle payment signs consistently',
      'Use PMT, IPMT, and PPMT to build debt schedules',
      'Know when multiple IRRs make a result unreliable',
    ],
    sections: [
      {
        title: 'NPV And XNPV',
        content:
          'Excel NPV assumes equal time spacing and discounts the first listed cash flow one period forward. XNPV uses actual dates, which makes it better for transaction models and irregular cash flows.',
        keyPoints: [
          'Do not include time-zero cash flow inside Excel NPV without adjusting',
          'XNPV uses actual day counts',
          'Sign conventions must stay consistent across all periods',
        ],
      },
      {
        title: 'IRR Caution',
        content:
          'IRR can fail or mislead when cash flow signs change multiple times. Always pair IRR with NPV, payback, and sensitivity analysis when evaluating investments.',
        keyPoints: [
          'Multiple sign changes can create multiple IRRs',
          'IRR assumes reinvestment at the IRR rate',
          'MIRR can be more realistic for reinvestment assumptions',
        ],
      },
      {
        title: 'Date-Aware Cash Flow Checks',
        content:
          'Finance-function models need explicit timing checks. The workbook should show whether cash flows are periodic or dated, whether signs are consistent, and which function owns the time-zero flow.',
        keyPoints: [
          'Use XNPV and XIRR when dates are irregular',
          'Keep investment outflows and inflows consistently signed',
          'Pair return metrics with value metrics before recommending a deal',
        ],
      },
    ],
    formulas: [
      { name: 'NPV With Time Zero', latex: 'CF_0 + \\text{NPV}(rate, CF_1:CF_N)', description: 'Keeps the immediate cash flow outside Excel NPV timing.' },
      { name: 'XNPV', latex: '\\text{XNPV}(\\text{rate}, \\text{cash flows}, \\text{dates})', description: 'Discounts irregular dated cash flows with actual timing.' },
      { name: 'XIRR', latex: '\\text{XIRR}(\\text{cash flows}, \\text{dates})', description: 'Solves the annualized return for irregular dated cash flows.' },
      { name: 'PMT', latex: '\\text{PMT}(\\text{rate}, \\text{nper}, \\text{pv})', description: 'Calculates the level payment for a loan or annuity.' },
    ],
    exercise: 'xnpv-builder',
  },
  'dcf-modeling': {
    title: 'DCF Modeling',
    summary:
      'Build a clean discounted cash flow model with operating drivers, WACC, terminal value, and sensitivity analysis.',
    outcomes: [
      'Forecast free cash flow from business drivers',
      'Calculate WACC with explicit capital structure assumptions',
      'Compare terminal growth and exit multiple approaches',
      'Run sensitivity cases without breaking the base model',
    ],
    sections: [
      {
        title: 'Free Cash Flow',
        content:
          'DCF quality depends on driver quality. Revenue growth, margin progression, reinvestment, working capital, and tax assumptions should connect to the business story rather than float as isolated percentages.',
        keyPoints: [
          'NOPAT starts with operating profit after tax',
          'Reinvestment includes capex and working capital',
          'Terminal assumptions often drive most of the valuation',
        ],
      },
      {
        title: 'Sensitivity Design',
        content:
          'Sensitivity tables should isolate the assumptions that truly matter. WACC, terminal growth, margin, and revenue growth are common candidates, but the right variables depend on the company.',
        keyPoints: [
          'Keep the base case separate from scenarios',
          'Use checks to catch impossible assumptions',
          'Show valuation ranges, not false precision',
        ],
      },
      {
        title: 'Valuation Bridge',
        content:
          'A DCF should bridge operating drivers to free cash flow, free cash flow to enterprise value, and enterprise value to equity value. Each bridge needs a visible check so the story and math stay aligned.',
        keyPoints: [
          'Tie revenue and margin assumptions to operating narrative',
          'Show terminal value as a percentage of enterprise value',
          'Reconcile enterprise value to equity value with net debt and non-operating assets',
        ],
      },
    ],
    formulas: [
      { name: 'Free Cash Flow', latex: 'FCF = EBIT(1-T) + D\\&A - Capex - \\Delta NWC', description: 'Operating cash flow available to capital providers.' },
      { name: 'WACC', latex: 'WACC = w_e r_e + w_d r_d(1-T)', description: 'Weighted required return for equity and after-tax debt capital.' },
      { name: 'Terminal Value', latex: 'TV = \\frac{FCF_{N+1}}{WACC-g}', description: 'Continuing value under a stable-growth assumption.' },
      { name: 'Enterprise Value', latex: 'EV = \\sum \\frac{FCF_t}{(1+WACC)^t} + \\frac{TV}{(1+WACC)^N}', description: 'Discounted value of forecast and terminal free cash flows.' },
    ],
    exercise: 'dcf-sensitivity',
  },
  'vba-macros': {
    title: 'VBA & Macros',
    summary:
      'Automate repeatable workbook tasks while keeping macros readable, reversible, and safe for finance workflows.',
    outcomes: [
      'Understand procedures, variables, ranges, loops, and conditions',
      'Record macros and then clean generated code',
      'Build user-defined functions for repeatable calculations',
      'Avoid destructive workbook automation patterns',
    ],
    sections: [
      {
        title: 'Macro Hygiene',
        content:
          'Recorded macros are useful drafts, not production code. Clean selections, qualify workbook and worksheet references, and make every destructive step explicit.',
        keyPoints: [
          'Avoid Select and Activate in cleaned macros',
          'Qualify all workbook and worksheet references',
          'Turn screen updating back on after automation',
        ],
      },
      {
        title: 'Reusable Procedures',
        content:
          'Good VBA breaks work into small procedures with clear inputs. A macro that formats a report, refreshes a model, and exports a PDF should have separate named steps so it can be tested and repaired.',
        keyPoints: [
          'Prefer explicit variable declarations',
          'Use Option Explicit',
          'Add guardrails before deleting or overwriting data',
        ],
      },
      {
        title: 'Automation Controls',
        content:
          'Finance macros should be reversible where possible and explicit where not. Logging, confirmation prompts, and workbook-scoped references reduce the risk of damaging the wrong file.',
        keyPoints: [
          'Qualify every workbook, worksheet, and range reference',
          'Restore application settings after errors',
          'Log destructive actions before they run',
        ],
      },
    ],
    formulas: [
      { name: 'Option Explicit', latex: '\\text{Option Explicit}', description: 'Requires declared variables before a macro can run.' },
      { name: 'Qualified Range', latex: '\\text{ThisWorkbook.Worksheets("Model").Range("A1")}', description: 'Targets a range without relying on the active sheet.' },
      { name: 'Safe Toggle', latex: '\\text{Application.ScreenUpdating}: False \\rightarrow True', description: 'Pairs performance settings with a restoration step.' },
    ],
    exercise: 'macro-planner',
  },
};
