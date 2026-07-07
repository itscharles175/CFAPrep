/**
 * AccessibleQuestionRunner — A11Y-2.
 *
 * A reusable, WCAG-compliant single-select question primitive that any host quiz
 * or drill surface can adopt. It implements the APG radiogroup pattern correctly
 * (which a list of <button>s does not):
 *
 *   - role="radiogroup" wrapper with an accessible name + aria-describedby for
 *     the question stem.
 *   - role="radio" + aria-checked on each option.
 *   - ROVING TABINDEX: exactly one option is tabbable (tabIndex 0); the rest are
 *     tabIndex -1. Tab enters/leaves the group as a single stop.
 *   - Full keyboard operation: ↑/← move to previous, ↓/→ move to next (wrapping),
 *     Home/End jump to first/last, Space/Enter select the focused option, and
 *     letter keys (A–…) jump to and select an option directly.
 *   - aria-live region announcing post-confirmation feedback (correct/incorrect +
 *     explanation) so screen-reader users hear the result without hunting for it.
 *
 * It is presentation-light by design: it reuses the host `.quiz-option` CSS
 * vocabulary (defined in src/index.css) so it looks identical to the existing
 * hand-rolled option lists, and it is fully controlled (selection + confirmation
 * state live in the parent) so adopting it never changes a surface's scoring,
 * persistence, or analytics. Reduced-motion is inherited from the global CSS net.
 */

import {
  forwardRef,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { cn } from '../ui/cn';
import AccessibleChoiceGroup, {
  type AccessibleChoiceGroupHandle,
  type AccessibleChoiceGroupOption,
} from './AccessibleChoiceGroup';

export interface RunnerOption {
  /** Stable key (falls back to index when absent). */
  id?: string | number;
  /** Option body text. */
  text: string;
}

export interface AccessibleQuestionRunnerProps {
  /** The question stem (rendered + used as the group's described-by text). */
  question: string;
  /** Answer options in display order. */
  options: RunnerOption[];
  /** Accessible name for the radiogroup. Default: "Answer options". */
  groupLabel?: string;
  /** Currently selected option index, or null when none chosen. Controlled. */
  selectedIndex: number | null;
  /** Fires when the user picks an option (click/Space/Enter/letter). */
  onSelect: (index: number) => void;
  /**
   * When true the question is answered and locked: options become read-only,
   * the correct/incorrect styling is applied, and feedback is announced.
   */
  confirmed?: boolean;
  /** Index of the correct option (only used for styling/feedback when confirmed). */
  correctIndex?: number;
  /** Optional explanation announced + shown after confirmation. */
  explanation?: string;
  /** Optional letters (default A, B, C, …). */
  letters?: string[];
  /** Extra className on the radiogroup. */
  className?: string;
  /** Optional content rendered below the options (e.g. confidence controls). */
  children?: React.ReactNode;
  /** Disable all interaction (e.g. while paused). */
  disabled?: boolean;
  /**
   * When the host already renders the question stem (e.g. inside a QuestionStage
   * shell), set this so the runner keeps the stem for `aria-describedby` but
   * hides it visually (sr-only) instead of printing it twice.
   */
  hideStem?: boolean;
}

export interface AccessibleQuestionRunnerHandle {
  /** Programmatically focus an option by index (used by hands-free mode). */
  focusOption: (index: number) => void;
  /** Focus the currently selected option, or the first option. */
  focusActive: () => void;
}

const DEFAULT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export const AccessibleQuestionRunner = forwardRef<
  AccessibleQuestionRunnerHandle,
  AccessibleQuestionRunnerProps
>(function AccessibleQuestionRunner(
  {
    question,
    options,
    groupLabel = 'Answer options',
    selectedIndex,
    onSelect,
    confirmed = false,
    correctIndex,
    explanation,
    letters = DEFAULT_LETTERS,
    className,
    children,
    disabled = false,
    hideStem = false,
  },
  ref,
) {
  const stemId = useId();
  const feedbackId = useId();
  const groupRef = useRef<AccessibleChoiceGroupHandle>(null);

  const runnerOptions = useMemo<AccessibleChoiceGroupOption<number>[]>(
    () =>
      options.map((option, index) => ({
        id: option.id ?? index,
        value: index,
        shortcut: letters[index],
      })),
    [letters, options],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusOption: (index: number) => groupRef.current?.focusOption(index),
      focusActive: () => groupRef.current?.focusActive(),
    }),
    [],
  );

  const feedback = useMemo(() => {
    if (!confirmed || correctIndex == null) return null;
    const isCorrect = selectedIndex === correctIndex;
    return {
      isCorrect,
      headline: isCorrect ? 'Correct' : 'Incorrect',
    };
  }, [confirmed, correctIndex, selectedIndex]);

  return (
    <div className={className}>
      <p id={stemId} className={hideStem ? 'sr-only' : 'aqr-stem'}>
        {question}
      </p>

      <AccessibleChoiceGroup
        ref={groupRef}
        options={runnerOptions}
        selectedValue={selectedIndex}
        onSelect={(value) => onSelect(Number(value))}
        groupLabel={groupLabel}
        describedBy={stemId}
        disabled={disabled}
        readOnly={confirmed}
        className="quiz-options"
      >
        {({ index, radioProps }) => {
          const option = options[index];
          const isSelected = selectedIndex === index;
          const isCorrect = confirmed && correctIndex === index;
          const isMissed = confirmed && isSelected && correctIndex !== index;
          const optionLabel = `${letters[index] ?? index + 1}. ${option.text}`;
          return (
            <button
              key={option.id ?? index}
              {...radioProps}
              aria-label={optionLabel}
              className={cn('quiz-option', {
                selected: isSelected && !confirmed,
                correct: isCorrect,
                incorrect: isMissed,
              })}
            >
              <span className="quiz-option-letter" aria-hidden="true">
                {letters[index] ?? index + 1}
              </span>
              <span style={{ flex: 1, textAlign: 'left' }}>{option.text}</span>
            </button>
          );
        }}
      </AccessibleChoiceGroup>

      {/* aria-live feedback: SR users hear the result + explanation on confirm. */}
      <div id={feedbackId} aria-live="polite" role="status" className="aqr-feedback">
        {feedback && (
          <div className={cn('quiz-explanation', feedback.isCorrect ? 'is-correct' : 'is-incorrect')}>
            <h4>{feedback.headline}</h4>
            {explanation && (
              <p className="qv-fs-sm qv-text-secondary qv-m-0" style={{ lineHeight: 1.6 }}>
                {explanation}
              </p>
            )}
          </div>
        )}
      </div>

      {children}
    </div>
  );
});

export default AccessibleQuestionRunner;
