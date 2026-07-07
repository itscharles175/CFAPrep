/**
 * A11Y-2 / A11Y-3 — component tests for the accessible runner + hands-free controller.
 *
 * Verifies the WCAG radiogroup semantics (roles, roving tabindex, keyboard nav,
 * aria-live feedback) and the Test-Mode safety rule for voice answers (never
 * auto-commit during a timed exam).
 */
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import AccessibleQuestionRunner from './AccessibleQuestionRunner';
import HandsFreeController from './HandsFreeController';
import { HandsFreeEngine } from '../../lib/handsFree';

const OPTIONS = [
  { id: 'o1', text: 'Alpha' },
  { id: 'o2', text: 'Beta' },
  { id: 'o3', text: 'Gamma' },
  { id: 'o4', text: 'Delta' },
];

function Harness({ confirmed = false, correctIndex }: { confirmed?: boolean; correctIndex?: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <AccessibleQuestionRunner
      question="Pick the right letter of the Greek alphabet."
      options={OPTIONS}
      selectedIndex={selected}
      onSelect={setSelected}
      confirmed={confirmed}
      correctIndex={correctIndex}
      explanation="Beta is the second letter."
    />
  );
}

describe('AccessibleQuestionRunner (A11Y-2)', () => {
  it('renders a radiogroup of radios with an accessible name', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Answer options' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('uses roving tabindex: exactly one radio is tabbable', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(radios.filter((r) => r.getAttribute('tabindex') === '-1')).toHaveLength(3);
  });

  it('selects on click and sets aria-checked', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('supports arrow-key navigation with wraparound and Space to select', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(radios[1]).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    fireEvent.keyDown(group, { key: 'ArrowUp' }); // wraps from 0 to last
    expect(radios[3]).toHaveFocus();
    fireEvent.keyDown(group, { key: ' ' });
    expect(radios[3]).toHaveAttribute('aria-checked', 'true');
  });

  it('Home/End jump to the first/last option', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    radios[1].focus();
    fireEvent.keyDown(group, { key: 'End' });
    expect(radios[3]).toHaveFocus();
    fireEvent.keyDown(group, { key: 'Home' });
    expect(radios[0]).toHaveFocus();
  });

  it('letter shortcut jumps to and selects the matching option', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(group, { key: 'c' });
    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
  });

  it('announces correct/incorrect feedback in an aria-live status region', () => {
    render(<Harness confirmed correctIndex={1} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Incorrect');
    expect(status).toHaveTextContent('Beta is the second letter.');
  });

  it('locks options once confirmed (no further selection)', () => {
    function Locked() {
      const [selected, setSelected] = useState<number | null>(0);
      return (
        <AccessibleQuestionRunner
          question="Q"
          options={OPTIONS}
          selectedIndex={selected}
          onSelect={setSelected}
          confirmed
          correctIndex={1}
        />
      );
    }
    render(<Locked />);
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[2]);
    // Still the originally-selected option 0; click had no effect.
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[2]).toHaveAttribute('aria-checked', 'false');
  });
});

describe('HandsFreeController (A11Y-3)', () => {
  const VOICE_OPTIONS = OPTIONS.map((o, i) => ({ letter: ['A', 'B', 'C', 'D'][i], text: o.text }));

  // jsdom has neither SpeechSynthesis nor SpeechRecognition; stub their presence
  // so the controller (which hides itself when both are absent) renders. The
  // actual TTS/STT are injected via the `engine` prop, so these are presence-only.
  beforeAll(() => {
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {};
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {};
  });
  afterAll(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it('reads the question aloud via the engine', async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const engine = new HandsFreeEngine({ speak });
    render(
      <HandsFreeController
        question="What is Beta?"
        options={VOICE_OPTIONS}
        onSelect={vi.fn()}
        engine={engine}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /read question/i }));
    await waitFor(() => expect(speak).toHaveBeenCalled());
    expect(speak.mock.calls[0][0]).toContain('Option A. Alpha');
  });

  it('outside test mode, a voice answer is applied directly', async () => {
    const onSelect = vi.fn();
    const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option C' }) });
    render(
      <HandsFreeController
        question="Q"
        options={VOICE_OPTIONS}
        onSelect={onSelect}
        engine={engine}
        testMode={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(2));
  });

  it('TEST MODE: a voice answer is NOT committed until explicitly confirmed', async () => {
    const onSelect = vi.fn();
    const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option B' }) });
    render(
      <HandsFreeController
        question="Q"
        options={VOICE_OPTIONS}
        onSelect={onSelect}
        engine={engine}
        testMode
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    // Confirmation prompt appears; nothing committed yet.
    await screen.findByText(/Confirm to apply/i);
    expect(onSelect).not.toHaveBeenCalled();
    // Only after the explicit confirm does it commit.
    fireEvent.click(screen.getByRole('button', { name: /Confirm Option B/i }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('TEST MODE: discarding a heard answer commits nothing', async () => {
    const onSelect = vi.fn();
    const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option D' }) });
    render(
      <HandsFreeController question="Q" options={VOICE_OPTIONS} onSelect={onSelect} engine={engine} testMode />,
    );
    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    await screen.findByText(/Confirm to apply/i);
    fireEvent.click(screen.getByRole('button', { name: /Discard/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('prompts to retry when no option is recognized', async () => {
    const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'mumble' }) });
    render(<HandsFreeController question="Q" options={VOICE_OPTIONS} onSelect={vi.fn()} engine={engine} />);
    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    await screen.findByText(/Didn’t catch an option/i);
  });

  it('accepts domain style hooks while preserving button names and status semantics', async () => {
    const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option B' }) });
    render(
      <HandsFreeController
        question="Q"
        options={VOICE_OPTIONS}
        onSelect={vi.fn()}
        engine={engine}
        testMode
        className="lsat-hands-free"
        buttonClassName="lsat-button"
        primaryButtonClassName="lsat-primary"
        secondarySmallButtonClassName="lsat-secondary-small"
        statusClassName="lsat-status"
        confirmRowClassName="lsat-confirm-row"
        mutedTextClassName="lsat-muted"
        errorClassName="lsat-error"
        spinnerClassName="lsat-spin"
      />,
    );

    const group = screen.getByRole('group', { name: /hands-free study controls/i });
    expect(group).toHaveClass('hands-free-controller');
    expect(group).toHaveClass('lsat-hands-free');
    expect(screen.getByRole('button', { name: /answer by voice/i })).toHaveClass('lsat-button');

    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    const status = await screen.findByRole('status');
    expect(status).toHaveClass('lsat-status');
    expect(screen.getByRole('button', { name: /confirm option b/i })).toHaveClass('lsat-primary');
  });
});

/**
 * Adoption-shape test: mirrors exactly how CfaQuiz composes the runner —
 * `hideStem` (the page's QuestionStage already shows the stem), children
 * (confidence/error controls), and a sibling HandsFreeController feeding the
 * same `onSelect`. Proves the integration contract without dragging in the
 * page's heavy data/loader/LLM dependencies.
 */
describe('CfaQuiz adoption shape', () => {
  const VOICE_OPTIONS = OPTIONS.map((o, i) => ({ letter: ['A', 'B', 'C', 'D'][i], text: o.text }));

  beforeAll(() => {
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {};
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {};
  });
  afterAll(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it('hideStem keeps the stem for aria-describedby but visually hides it; children + voice share onSelect', async () => {
    function Page() {
      const [selected, setSelected] = useState<number | null>(null);
      const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option C' }) });
      return (
        <>
          <HandsFreeController
            question="What is the NPV?"
            options={VOICE_OPTIONS}
            onSelect={setSelected}
            testMode={false}
            engine={engine}
          />
          <AccessibleQuestionRunner
            question="What is the NPV?"
            hideStem
            options={OPTIONS}
            selectedIndex={selected}
            onSelect={setSelected}
          >
            <div data-testid="extra-controls">Confidence + error controls</div>
          </AccessibleQuestionRunner>
        </>
      );
    }
    render(<Page />);

    // Stem is present (for aria-describedby) but sr-only (visually hidden).
    const group = screen.getByRole('radiogroup');
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const stem = document.getElementById(describedBy as string);
    expect(stem).toHaveClass('sr-only');

    // Children render below the options.
    expect(screen.getByTestId('extra-controls')).toBeInTheDocument();

    // Untimed voice answer flows through the same setter the radiogroup uses.
    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('radio')[2]).toHaveAttribute('aria-checked', 'true'),
    );
  });
});

describe('CFA mock/vignette hands-free adoption shape', () => {
  const VOICE_OPTIONS = OPTIONS.map((o, i) => ({ letter: ['A', 'B', 'C', 'D'][i], text: o.text }));

  beforeAll(() => {
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {};
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {};
  });
  afterAll(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it('timed mock shape requires voice confirmation before applying the numeric selected index', async () => {
    function Page() {
      const [selected, setSelected] = useState<number | null>(null);
      const engine = new HandsFreeEngine({ recognize: vi.fn().mockResolvedValue({ transcript: 'option B' }) });
      return (
        <>
          <HandsFreeController
            question="Case facts. The project has uneven cash flows. Question. What is the NPV?"
            options={VOICE_OPTIONS}
            onSelect={setSelected}
            testMode
            engine={engine}
          />
          <AccessibleQuestionRunner
            question="What is the NPV?"
            hideStem
            options={OPTIONS}
            selectedIndex={selected}
            onSelect={setSelected}
          />
        </>
      );
    }
    render(<Page />);

    fireEvent.click(screen.getByRole('button', { name: /answer by voice/i }));
    await screen.findByText(/Confirm to apply/i);
    expect(screen.getAllByRole('radio')[1]).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: /confirm option b/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('radio')[1]).toHaveAttribute('aria-checked', 'true'),
    );
  });
});
