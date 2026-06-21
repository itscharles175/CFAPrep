/**
 * handsFree.ts — A11Y-3 hands-free study mode logic (framework-agnostic core).
 *
 * This is the pure, testable substrate behind the `HandsFreeController` component:
 *   - reading a question + its options aloud (uses the existing local TTS in
 *     `src/lib/voice.js` — `speak`/`sanitizeForSpeech`), and
 *   - mapping a free-form spoken transcript to a chosen option index (the STT
 *     itself — `recognizeOnce`/`recognizeOnceOffline` — also lives in voice.js).
 *
 * It is deliberately decoupled from any specific reading engine: callers inject
 * the `speak`/`recognize` functions (defaulting to the shared voice.js helpers),
 * so this slice never hard-depends on another slice's TTS internals. Everything
 * degrades gracefully — if the browser has no speech APIs, the capability flags
 * are false and the controller hides the affordance.
 *
 * TEST-MODE SAFETY: this module only ever *resolves an intent*. It never advances
 * a question or submits an exam on its own. The controller enforces that a voice
 * answer during a timed exam requires explicit on-screen confirmation before it
 * commits — see `HandsFreeController`. Keeping the commit decision out of here
 * makes the rule auditable and impossible to bypass via the voice path.
 */

import {
  hasSpeechRecognition,
  hasSpeechSynthesis,
  recognizeOnce as defaultRecognizeOnce,
  sanitizeForSpeech,
  speak as defaultSpeak,
} from './voice.js';

export interface VoiceCapabilities {
  /** SpeechSynthesis (read-aloud) available. */
  canSpeak: boolean;
  /** Browser SpeechRecognition (voice answer) available. */
  canListen: boolean;
}

/** Detect what the current environment supports. SSR/jsdom-safe (all false). */
export function detectVoiceCapabilities(): VoiceCapabilities {
  return {
    canSpeak: hasSpeechSynthesis(),
    canListen: hasSpeechRecognition(),
  };
}

/** A single answer option as the matcher understands it. */
export interface VoiceOption {
  /** Display letter (A, B, C, D…). */
  letter: string;
  /** Full option text. */
  text: string;
}

export interface VoiceMatch {
  /** Index of the matched option, or -1 when nothing matched confidently. */
  index: number;
  /** How the match was found, for honest UI feedback. */
  reason: 'letter' | 'ordinal' | 'text' | 'none';
  /** 0..1 rough confidence (1 = explicit letter/ordinal, lower = fuzzy text). */
  confidence: number;
}

// Explicit ordinals + digits are unambiguous answer cues.
const STRONG_ORDINAL_WORDS: Record<string, number> = {
  first: 0,
  '1': 0,
  second: 1,
  '2': 1,
  third: 2,
  '3': 2,
  fourth: 3,
  '4': 3,
  fifth: 4,
  '5': 4,
};
// Bare cardinal words ("one", "two") double as common English words, so they
// only count as an answer in a short utterance or right after a cue word —
// otherwise "this is a tricky one" would falsely resolve to option 1.
const WEAK_ORDINAL_WORDS: Record<string, number> = {
  one: 0,
  two: 1,
  three: 2,
  four: 3,
  five: 4,
};
const ORDINAL_CUES = new Set(['option', 'answer', 'number', 'choice', 'select', 'the']);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a spoken transcript onto an option index. Resolution order, most explicit
 * first:
 *   1. A spoken letter — "A", "answer B", "option c", "letter d".
 *   2. An ordinal — "the first one", "option two", "number 3".
 *   3. Fuzzy text containment — the transcript contains an option's text (or
 *      vice-versa) for long enough options to be unambiguous.
 *
 * Returns `{ index: -1, reason: 'none' }` when nothing matches, so the caller can
 * ask the user to repeat rather than guessing — important under exam conditions.
 */
export function matchSpokenAnswer(transcript: string, options: VoiceOption[]): VoiceMatch {
  const norm = normalize(transcript);
  if (!norm || options.length === 0) {
    return { index: -1, reason: 'none', confidence: 0 };
  }
  const tokens = norm.split(' ');

  // 1) Explicit letter. Accept a bare single-letter token matching an option's
  //    letter ("a"), guarding against it being a real English word ("a", "i").
  for (let i = 0; i < options.length; i += 1) {
    const letter = options[i].letter.toLowerCase();
    if (!letter) continue;
    // "option a" / "answer b" / "letter c" / "choice d" — cue word + letter.
    const cued = new RegExp(`\\b(?:option|answer|letter|choice|select)\\s+${letter}\\b`);
    if (cued.test(norm)) {
      return { index: i, reason: 'letter', confidence: 1 };
    }
    // A standalone letter token, only when it's not the article "a" sitting in a
    // longer sentence (a single-token transcript like "a" is intentional).
    if (tokens.includes(letter) && (tokens.length === 1 || letter !== 'a')) {
      return { index: i, reason: 'letter', confidence: 0.95 };
    }
  }

  // 2) Ordinal / number. Strong ordinals (first/1) always count; weak cardinals
  //    (one/two) only when the utterance is short or the token follows a cue word.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const strong = STRONG_ORDINAL_WORDS[token];
    if (strong !== undefined && strong < options.length) {
      return { index: strong, reason: 'ordinal', confidence: 0.85 };
    }
    const weak = WEAK_ORDINAL_WORDS[token];
    if (weak !== undefined && weak < options.length) {
      const cued = i > 0 && ORDINAL_CUES.has(tokens[i - 1]);
      if (tokens.length <= 3 || cued) {
        return { index: weak, reason: 'ordinal', confidence: 0.8 };
      }
    }
  }

  // 3) Fuzzy text containment — only for options with enough signal (>= 4 chars
  //    of normalized text) to avoid matching stop-words.
  let best: VoiceMatch = { index: -1, reason: 'none', confidence: 0 };
  for (let i = 0; i < options.length; i += 1) {
    const optNorm = normalize(options[i].text);
    if (optNorm.length < 4) continue;
    if (norm.includes(optNorm)) {
      const confidence = Math.min(0.8, 0.4 + optNorm.length / 100);
      if (confidence > best.confidence) best = { index: i, reason: 'text', confidence };
    } else if (optNorm.includes(norm) && norm.length >= 4) {
      const confidence = Math.min(0.6, 0.3 + norm.length / 100);
      if (confidence > best.confidence) best = { index: i, reason: 'text', confidence };
    }
  }
  return best;
}

/**
 * Build the utterance read aloud for a question + its options. Citation markers
 * are stripped via the shared `sanitizeForSpeech`; options are announced with
 * their letters so the user knows what to say back.
 */
export function buildReadAloudScript(params: {
  question: string;
  options: VoiceOption[];
  /** Optional preface, e.g. "Question 3 of 20." */
  preface?: string;
}): string {
  const { question, options, preface } = params;
  const parts: string[] = [];
  if (preface) parts.push(sanitizeForSpeech(preface));
  parts.push(sanitizeForSpeech(question));
  for (const opt of options) {
    parts.push(`Option ${opt.letter}. ${sanitizeForSpeech(opt.text)}`);
  }
  return parts.filter(Boolean).join('. ');
}

/** Injectable speak fn signature (matches voice.js `speak`). */
export type SpeakFn = (text: string, options?: { signal?: AbortSignal; rate?: number }) => Promise<void>;
/** Injectable recognize fn signature (matches voice.js `recognizeOnce`). */
export type RecognizeFn = (options?: {
  signal?: AbortSignal;
  lang?: string;
}) => Promise<{ transcript: string }>;

export interface HandsFreeEngineOptions {
  speak?: SpeakFn;
  recognize?: RecognizeFn;
}

/**
 * A tiny stateful engine the controller drives. It owns the in-flight
 * AbortControllers for the current read/listen so they can be cancelled cleanly
 * (e.g. on unmount or when the user advances). Pure orchestration — no DOM.
 */
export class HandsFreeEngine {
  private readonly speakFn: SpeakFn;
  private readonly recognizeFn: RecognizeFn;
  private readAbort: AbortController | null = null;
  private listenAbort: AbortController | null = null;

  constructor(options: HandsFreeEngineOptions = {}) {
    this.speakFn = options.speak ?? (defaultSpeak as unknown as SpeakFn);
    this.recognizeFn = options.recognize ?? (defaultRecognizeOnce as unknown as RecognizeFn);
  }

  /** Read a script aloud. Cancels any prior in-flight read. Resolves when done. */
  async read(script: string): Promise<void> {
    this.cancelRead();
    if (!script.trim()) return;
    const controller = new AbortController();
    this.readAbort = controller;
    try {
      await this.speakFn(script, { signal: controller.signal });
    } catch (error) {
      // Aborts are expected (cancel/advance); swallow them, rethrow real errors.
      if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
      throw error;
    } finally {
      if (this.readAbort === controller) this.readAbort = null;
    }
  }

  /**
   * Listen once and resolve the matched option index against `options`.
   * Returns the match + the raw transcript so the UI can echo what it heard.
   */
  async listenForAnswer(options: VoiceOption[]): Promise<VoiceMatch & { transcript: string }> {
    this.cancelListen();
    const controller = new AbortController();
    this.listenAbort = controller;
    try {
      const { transcript } = await this.recognizeFn({ signal: controller.signal });
      const match = matchSpokenAnswer(transcript, options);
      return { ...match, transcript };
    } finally {
      if (this.listenAbort === controller) this.listenAbort = null;
    }
  }

  cancelRead(): void {
    this.readAbort?.abort();
    this.readAbort = null;
  }

  cancelListen(): void {
    this.listenAbort?.abort();
    this.listenAbort = null;
  }

  /** Cancel everything in flight (call on unmount). */
  cancelAll(): void {
    this.cancelRead();
    this.cancelListen();
  }
}
