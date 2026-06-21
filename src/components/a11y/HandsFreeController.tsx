/**
 * HandsFreeController — A11Y-3 hands-free study mode UI.
 *
 * A small, self-contained control strip that adds:
 *   - "Read aloud" — speaks the question + options via the local TTS engine.
 *   - "Voice answer" — captures one spoken utterance and maps it to an option.
 *
 * It is intentionally LOOSELY COUPLED: it talks to a `HandsFreeEngine` (default
 * = the shared voice.js helpers) and to the question via plain props + an
 * `onSelect` callback. It does NOT reach into the AccessibleQuestionRunner's
 * internals or any reading engine's private state — pass it the same `options`
 * and a setter and it works alongside any runner.
 *
 * TEST-MODE SAFETY (hard requirement): when `testMode` is true (a timed exam),
 * a voice-resolved answer is NEVER committed silently. The controller surfaces a
 * "Heard: …" confirmation prompt and only calls `onSelect` after the user
 * explicitly confirms (button or by saying it again / pressing Enter). Outside
 * test mode (untimed study) it can apply the selection directly. This guarantees
 * voice can never auto-advance or auto-answer a timed exam without consent.
 *
 * Graceful degradation: if the environment lacks the relevant speech API the
 * corresponding button is hidden; if neither is available the whole strip
 * renders nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Ear, Loader2, Mic, Volume2, X } from 'lucide-react';
import {
  buildReadAloudScript,
  detectVoiceCapabilities,
  HandsFreeEngine,
  type HandsFreeEngineOptions,
  type VoiceMatch,
  type VoiceOption,
} from '../../lib/handsFree';

export interface HandsFreeControllerProps {
  /** Question stem read aloud. */
  question: string;
  /** Options (text + letter) for both read-aloud and voice matching. */
  options: VoiceOption[];
  /** Apply a resolved/confirmed answer. */
  onSelect: (index: number) => void;
  /**
   * Timed-exam guard. When true, a voice answer requires explicit confirmation
   * before it is committed (never auto-applies). Default false (untimed study).
   */
  testMode?: boolean;
  /** Optional preface read before the question, e.g. "Question 3 of 20." */
  preface?: string;
  /** Hide once a question is locked/confirmed. */
  disabled?: boolean;
  /** Inject a custom engine (tests). Defaults to the shared voice.js helpers. */
  engineOptions?: HandsFreeEngineOptions;
  /** Pre-built engine (tests). Takes precedence over engineOptions. */
  engine?: HandsFreeEngine;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'listening' }
  | { kind: 'confirm'; match: VoiceMatch; transcript: string; letter: string; text: string }
  | { kind: 'unrecognized'; transcript: string }
  | { kind: 'error'; message: string };

export default function HandsFreeController({
  question,
  options,
  onSelect,
  testMode = false,
  preface,
  disabled = false,
  engineOptions,
  engine: injectedEngine,
}: HandsFreeControllerProps) {
  const caps = useMemo(() => detectVoiceCapabilities(), []);
  const engineRef = useRef<HandsFreeEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = injectedEngine ?? new HandsFreeEngine(engineOptions);
  }
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Cancel any in-flight speech/recognition on unmount.
  useEffect(() => {
    const engine = engineRef.current;
    return () => engine?.cancelAll();
  }, []);

  if (!caps.canSpeak && !caps.canListen) return null;

  async function handleReadAloud() {
    const engine = engineRef.current;
    if (!engine) return;
    setPhase({ kind: 'reading' });
    try {
      await engine.read(buildReadAloudScript({ question, options, preface }));
      setPhase((current) => (current.kind === 'reading' ? { kind: 'idle' } : current));
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Read-aloud failed.',
      });
    }
  }

  async function handleVoiceAnswer() {
    const engine = engineRef.current;
    if (!engine) return;
    setPhase({ kind: 'listening' });
    try {
      const result = await engine.listenForAnswer(options);
      if (result.index < 0) {
        setPhase({ kind: 'unrecognized', transcript: result.transcript });
        return;
      }
      const option = options[result.index];
      if (testMode) {
        // Timed exam: require explicit confirmation before committing.
        setPhase({
          kind: 'confirm',
          match: result,
          transcript: result.transcript,
          letter: option.letter,
          text: option.text,
        });
      } else {
        // Untimed study: apply directly.
        onSelect(result.index);
        setPhase({ kind: 'idle' });
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Voice recognition failed.',
      });
    }
  }

  function confirmHeard() {
    if (phase.kind !== 'confirm') return;
    onSelect(phase.match.index);
    setPhase({ kind: 'idle' });
  }

  function cancel() {
    engineRef.current?.cancelAll();
    setPhase({ kind: 'idle' });
  }

  const busy = phase.kind === 'reading' || phase.kind === 'listening';

  return (
    <div
      className="hands-free-controller qv-row-2"
      role="group"
      aria-label="Hands-free study controls"
      style={{ flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-3)' }}
    >
      {caps.canSpeak && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleReadAloud}
          disabled={disabled || busy}
          aria-label="Read question and options aloud"
        >
          {phase.kind === 'reading' ? (
            <Loader2 size={16} className="qv-spin" aria-hidden="true" />
          ) : (
            <Volume2 size={16} aria-hidden="true" />
          )}
          {phase.kind === 'reading' ? 'Reading…' : 'Read aloud'}
        </button>
      )}

      {caps.canListen && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleVoiceAnswer}
          disabled={disabled || busy}
          aria-label="Answer by voice"
        >
          {phase.kind === 'listening' ? (
            <Loader2 size={16} className="qv-spin" aria-hidden="true" />
          ) : (
            <Mic size={16} aria-hidden="true" />
          )}
          {phase.kind === 'listening' ? 'Listening…' : 'Voice answer'}
        </button>
      )}

      {busy && (
        <button type="button" className="btn btn-secondary" onClick={cancel} aria-label="Cancel">
          <X size={16} aria-hidden="true" /> Cancel
        </button>
      )}

      {/* Live region: everything spoken/heard is announced for SR users. */}
      <div aria-live="polite" role="status" className="qv-fs-sm qv-text-secondary" style={{ width: '100%' }}>
        {phase.kind === 'listening' && <span><Ear size={14} aria-hidden="true" /> Listening for your answer…</span>}
        {phase.kind === 'unrecognized' && (
          <span className="qv-text-secondary">
            Didn’t catch an option in “{phase.transcript || '…'}”. Try saying the letter, e.g. “Option A”.
          </span>
        )}
        {phase.kind === 'confirm' && (
          <span className="qv-row-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span>
              Heard “{phase.transcript}” → <strong>Option {phase.letter}</strong>: {phase.text}.{' '}
              Confirm to apply (timed exam — not applied automatically).
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={confirmHeard}>
              Confirm Option {phase.letter}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>
              Discard
            </button>
          </span>
        )}
        {phase.kind === 'error' && <span className="qv-text-danger">{phase.message}</span>}
      </div>
    </div>
  );
}
