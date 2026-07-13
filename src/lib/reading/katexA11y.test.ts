import { describe, expect, it } from 'vitest';
import {
  accessibleKatexOptions,
  decorateAccessibleMath,
  speakableFromLatex,
} from './katexA11y';

describe('accessibleKatexOptions — canonical a11y render options', () => {
  it('emits both HTML and MathML so screen readers get the semantic tree', () => {
    expect(accessibleKatexOptions().output).toBe('htmlAndMathml');
  });

  it('never throws on a malformed formula (renders source instead)', () => {
    expect(accessibleKatexOptions().throwOnError).toBe(false);
  });

  it('lets per-call overrides win (e.g. displayMode) while keeping the a11y output', () => {
    const opts = accessibleKatexOptions({ displayMode: true });
    expect(opts.displayMode).toBe(true);
    expect(opts.output).toBe('htmlAndMathml');
  });
});

describe('speakableFromLatex — spoken-formula linearisation', () => {
  it('returns empty for empty input', () => {
    expect(speakableFromLatex('')).toBe('');
  });

  it('reads exponents as words', () => {
    expect(speakableFromLatex('x^2')).toContain('squared');
    expect(speakableFromLatex('x^3')).toContain('cubed');
    expect(speakableFromLatex('x^{n}')).toContain('to the power of n');
  });

  it('reads fractions as "a over b"', () => {
    expect(speakableFromLatex('\\frac{a}{b}')).toContain('a over b');
  });

  it('reads square roots', () => {
    expect(speakableFromLatex('\\sqrt{x}')).toContain('square root of x');
  });

  it('maps common operators and relations to words', () => {
    expect(speakableFromLatex('a \\leq b')).toContain('less than or equal to');
    expect(speakableFromLatex('a \\times b')).toContain('times');
    expect(speakableFromLatex('\\sum x')).toContain('sum of');
  });

  it('reads bare arithmetic operators', () => {
    const spoken = speakableFromLatex('a + b = c');
    expect(spoken).toContain('plus');
    expect(spoken).toContain('equals');
  });

  it('collapses whitespace and never leaves raw braces', () => {
    const spoken = speakableFromLatex('\\frac{x^2}{y}');
    expect(spoken).not.toMatch(/[{}]/);
    expect(spoken).not.toMatch(/\s{2,}/);
  });
});

describe('decorateAccessibleMath — tags rendered output for AT', () => {
  it('hides the visual HTML and labels the MathML with the spoken form', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span class="katex-html">x2</span><math></math>';
    decorateAccessibleMath(host, 'x^2');
    expect(host.querySelector('.katex-html')?.getAttribute('aria-hidden')).toBe('true');
    const math = host.querySelector('math');
    expect(math?.getAttribute('role')).toBe('math');
    expect(math?.getAttribute('aria-label')).toContain('squared');
  });

  it('labels the container itself when no MathML is present', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span class="katex-html">x2</span>';
    decorateAccessibleMath(host, 'x^2');
    expect(host.getAttribute('role')).toBe('math');
    expect(host.getAttribute('aria-label')).toContain('squared');
  });
});
