import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FormulaBlock from './FormulaBlock';

// Mock katex so the accessible render path runs without the real engine: it
// writes a visual .katex-html span + a <math> sibling, exactly what the a11y
// decorator (katexA11y.decorateAccessibleMath) expects to tag.
vi.mock('katex', () => ({
  default: {
    render: (latex: string, el: HTMLElement) => {
      el.innerHTML = `<span class="katex-html">${latex}</span><math></math>`;
    },
  },
}));

beforeEach(() => {
  // jsdom has no speechSynthesis — provide a spy-able stub.
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
  };
  (
    window as unknown as { SpeechSynthesisUtterance: unknown }
  ).SpeechSynthesisUtterance = class {
    text: string;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FormulaBlock — GAP-MATHA11Y-1 accessible math', () => {
  it('renders with role=math + aria-label on the MathML output', async () => {
    render(<FormulaBlock latex="x^2" name="Quadratic" />);
    await waitFor(() => {
      const math = document.querySelector('math');
      expect(math?.getAttribute('role')).toBe('math');
      expect(math?.getAttribute('aria-label')).toContain('squared');
    });
    // The visual HTML is hidden from the a11y tree.
    expect(document.querySelector('.katex-html')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not show the speak button by default', () => {
    render(<FormulaBlock latex="x^2" name="Quadratic" />);
    expect(screen.queryByRole('button', { name: /Speak/ })).not.toBeInTheDocument();
  });

  it('speaks the linearised formula when the speakable button is pressed', async () => {
    const user = userEvent.setup();
    render(<FormulaBlock latex="\\frac{a}{b}" name="Ratio" speakable />);
    const button = screen.getByRole('button', { name: /Speak Ratio formula aloud/ });
    await user.click(button);
    const speak = (window.speechSynthesis as unknown as { speak: ReturnType<typeof vi.fn> }).speak;
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0][0] as { text: string };
    expect(utterance.text).toContain('a over b');
  });

  it('exposes a keyboard-scroll affordance when the rendered formula overflows', async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains('formula-render') ? 120 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains('formula-render') ? 280 : 0;
      },
    });

    try {
      render(<FormulaBlock latex="\\frac{a+b}{c+d}" name="Ratio" />);
      await waitFor(() => {
        expect(screen.getByText(/Scroll horizontally to view the full formula/)).toBeInTheDocument();
      });
      expect(document.querySelector('.formula-render')).toHaveAttribute('tabindex', '0');
    } finally {
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth);
    }
  });
});
