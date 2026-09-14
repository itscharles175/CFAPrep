import { useEffect, useId, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import {
  renderAccessibleMath,
  speakableFromLatex,
} from '../lib/reading/katexA11y';

export interface FormulaBlockProps {
  latex: string;
  name?: string;
  description?: string;
  compact?: boolean;
  /**
   * GAP-MATHA11Y-1 — show a "speak formula" button that reads the linearised
   * spoken form aloud via the Web Speech API (offline, OS voices). Opt-in so the
   * existing render sites are visually unchanged; defaults off.
   */
  speakable?: boolean;
}

export default function FormulaBlock({
  latex,
  name,
  description,
  compact = false,
  speakable = false,
}: FormulaBlockProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const overflowHintId = useId();

  useEffect(() => {
    let active = true;
    const target = ref.current;
    if (!target) return;
    setOverflowing(false);
    // GAP-MATHA11Y-1 — render with htmlAndMathml + role/aria so screen readers
    // announce the formula semantically. Helper handles the lazy katex import and
    // falls back to plain text on failure (never throws).
    const measureOverflow = () => {
      if (!active) return;
      setOverflowing(target.scrollWidth > target.clientWidth + 1);
    };
    let cleanupObserver = () => {};
    void renderAccessibleMath(latex, target, { displayMode: true }).then(() => {
      if (!active) return;
      measureOverflow();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measureOverflow);
        observer.observe(target);
        cleanupObserver = () => observer.disconnect();
      }
    });
    return () => {
      active = false;
      cleanupObserver();
    };
  }, [latex]);

  // Offline spoken-formula playback via the browser's built-in speech synthesis
  // (OS voices, no network). Cancels any in-flight utterance first so repeated
  // presses don't queue. Silently inert if the API is unavailable.
  function speak() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const text = speakableFromLatex(latex);
    if (!text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  return (
    <div
      className={compact ? 'formula-card compact' : 'formula-block'}
      role="group"
      tabIndex={0}
      aria-label={name ? `${name} formula` : 'Formula'}
      aria-describedby={overflowing ? overflowHintId : undefined}
    >
      {(name || speakable) && (
        <div className="formula-title-row">
          {name && <div className="formula-title">{name}</div>}
          {speakable && (
            <button
              type="button"
              className="btn-icon btn-ghost formula-speak"
              aria-label={`Speak ${name ? `${name} ` : ''}formula aloud`}
              aria-pressed={speaking}
              onClick={speak}
            >
              <Volume2 size={16} />
            </button>
          )}
        </div>
      )}
      <div
        ref={ref}
        className={`formula-render${overflowing ? ' formula-render--overflowing' : ''}`}
        tabIndex={overflowing ? 0 : undefined}
        aria-label={overflowing ? 'Scrollable formula' : undefined}
      />
      {overflowing && (
        <div id={overflowHintId} className="formula-overflow-hint" role="status">
          <span aria-hidden="true">↔</span> Scroll horizontally to view the full formula
        </div>
      )}
      {description && <div className="formula-description">{description}</div>}
    </div>
  );
}
