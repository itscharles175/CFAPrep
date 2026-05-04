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
    ],
    exercise: 'macro-planner',
  },
};
