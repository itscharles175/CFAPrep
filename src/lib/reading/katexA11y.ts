/**
 * GAP-MATHA11Y-1 — screen-reader-accessible math via KaTeX.
 *
 * KaTeX already emits an MathML sibling alongside its visual HTML when
 * `output: 'htmlAndMathml'` (its default) — assistive tech reads the MathML while
 * sighted users see the styled HTML. This module is the ONE place those options
 * are defined so every render site (FormulaBlock + any future KaTeX use) emits
 * the accessible output identically, instead of each call passing ad-hoc options.
 *
 * It also provides an OPTIONAL spoken-formula helper: a plain-text linearisation
 * of the rendered MathML that a "speak formula" affordance (TTS via the existing
 * kokoro/speak pipeline) or an aria-label can consume. Reading that text aloud is
 * left to the caller — this module only produces it, fully offline.
 */

/** The KaTeX option shape we depend on (structural; avoids a hard type import). */
export interface KatexRenderOptions {
  displayMode?: boolean;
  throwOnError?: boolean;
  output?: 'html' | 'mathml' | 'htmlAndMathml';
  /** KaTeX writes this onto the MathML <math> element's accessibility text. */
  [key: string]: unknown;
}

/**
 * Canonical KaTeX options for accessible rendering. `htmlAndMathml` is what makes
 * the formula screen-reader-navigable (the MathML carries the semantic tree);
 * `throwOnError: false` keeps a malformed formula from blowing up the page (it
 * renders the source in red instead). Merge a per-call `displayMode` over this.
 */
export function accessibleKatexOptions(
  overrides: KatexRenderOptions = {},
): KatexRenderOptions {
  return {
    output: 'htmlAndMathml',
    throwOnError: false,
    ...overrides,
  };
}

/**
 * Render LaTeX into a target element with accessible output. Centralises the
 * dynamic `import('katex')` (so it stays in the lazy katex chunk) and the option
 * merge. On any failure it falls back to showing the raw LaTeX as text content,
 * never throwing — callers can `await` it safely in an effect.
 *
 * After rendering, the KaTeX-produced MathML is given a `role="math"` +
 * `aria-label` of the spoken form so a screen reader announces the formula even
 * when MathML support is partial.
 */
export async function renderAccessibleMath(
  latex: string,
  target: HTMLElement,
  options: KatexRenderOptions = {},
): Promise<void> {
  try {
    const mod = await import('katex');
    const katex = (mod as { default?: unknown }).default ?? mod;
    (katex as { render: (tex: string, el: HTMLElement, opts: KatexRenderOptions) => void }).render(
      latex,
      target,
      accessibleKatexOptions(options),
    );
    decorateAccessibleMath(target, latex);
  } catch {
    target.textContent = latex;
  }
}

/**
 * Tag the rendered output so assistive tech treats it as a single math unit:
 *   - the visual HTML (`.katex-html`) is hidden from the a11y tree (aria-hidden),
 *   - the MathML root gets `role="math"` + an `aria-label` of the spoken form.
 * Safe to call repeatedly; a missing piece is simply skipped.
 */
export function decorateAccessibleMath(target: HTMLElement, latex: string): void {
  const visual = target.querySelector('.katex-html');
  if (visual) visual.setAttribute('aria-hidden', 'true');

  const mathml = target.querySelector('math');
  const label = speakableFromLatex(latex);
  if (mathml) {
    mathml.setAttribute('role', 'math');
    if (label) mathml.setAttribute('aria-label', label);
  } else {
    // No MathML available (e.g. `output: 'html'`): label the container itself so
    // the formula is still announced rather than read character-by-character.
    target.setAttribute('role', 'math');
    if (label) target.setAttribute('aria-label', label);
  }
}

/**
 * Produce a rough spoken-form string from a LaTeX source — the "spoken-formula"
 * option's text. This is a lightweight, dependency-free linearisation (not a full
 * MathML→speech engine): it maps the common operators/symbols to words so TTS or
 * an aria-label reads "x squared plus 2" rather than "x caret 2 plus 2". Unknown
 * commands degrade to their bare name. Deterministic + offline.
 */
export function speakableFromLatex(latex: string): string {
  if (!latex) return '';
  let s = latex;

  // Fractions: \frac{a}{b} → "a over b" (one level; nested fall back to literal).
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 over $2 ');
  // Square roots: \sqrt{a} → "square root of a".
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' square root of $1 ');
  // Superscripts: x^2 / x^{2} → "x squared/cubed/to the power of N".
  s = s.replace(/\^\s*\{?\s*2\s*\}?/g, ' squared ');
  s = s.replace(/\^\s*\{?\s*3\s*\}?/g, ' cubed ');
  s = s.replace(/\^\s*\{([^{}]*)\}/g, ' to the power of $1 ');
  s = s.replace(/\^\s*(\w+)/g, ' to the power of $1 ');
  // Subscripts: x_i / x_{i} → "x sub i".
  s = s.replace(/_\s*\{([^{}]*)\}/g, ' sub $1 ');
  s = s.replace(/_\s*(\w+)/g, ' sub $1 ');

  const symbols: Record<string, string> = {
    '\\times': ' times ',
    '\\cdot': ' times ',
    '\\div': ' divided by ',
    '\\pm': ' plus or minus ',
    '\\mp': ' minus or plus ',
    '\\leq': ' less than or equal to ',
    '\\le': ' less than or equal to ',
    '\\geq': ' greater than or equal to ',
    '\\ge': ' greater than or equal to ',
    '\\neq': ' not equal to ',
    '\\approx': ' approximately ',
    '\\sum': ' sum of ',
    '\\prod': ' product of ',
    '\\int': ' integral of ',
    '\\infty': ' infinity ',
    '\\partial': ' partial ',
    '\\alpha': ' alpha ',
    '\\beta': ' beta ',
    '\\gamma': ' gamma ',
    '\\delta': ' delta ',
    '\\sigma': ' sigma ',
    '\\mu': ' mu ',
    '\\pi': ' pi ',
    '\\theta': ' theta ',
    '\\lambda': ' lambda ',
    '\\rho': ' rho ',
  };
  for (const [tex, word] of Object.entries(symbols)) {
    s = s.split(tex).join(word);
  }

  // Bare operators.
  s = s.replace(/\+/g, ' plus ').replace(/(?<!\w)-(?!\w)/g, ' minus ').replace(/=/g, ' equals ');

  // Strip any remaining braces / leftover backslashes-commands → bare token.
  s = s.replace(/\\([a-zA-Z]+)/g, ' $1 ').replace(/[{}]/g, ' ');
  // Collapse whitespace.
  return s.replace(/\s+/g, ' ').trim();
}
