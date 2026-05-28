/**
 * Hands-free Socratic loop.
 *
 * Wraps the existing voice + LLM pieces so a user can have a continuous
 * spoken study dialog without touching the keyboard:
 *
 *   1. Speak a question
 *   2. Local LLM (Coach role) responds — speak the answer aloud
 *   3. After the answer finishes speaking, automatically reopen STT for the
 *      next user turn — until the user says "stop", "end session", or
 *      explicitly cancels.
 *
 * State machine:
 *   IDLE ─start()─> LISTENING ─transcript─> THINKING ─response─> SPEAKING
 *                                                                    │
 *                                                                    └─speech end─> LISTENING (back to step 1)
 *
 *   stop() at any point → IDLE (cancels in-flight STT/TTS/LLM)
 *
 * Default coach prompt asks the model to respond Socratically: short
 * answers, follow-up questions, no walls of text — ideal for spoken use.
 */

import { hasSpeechRecognition, hasSpeechSynthesis, recognizeOnce, sanitizeForSpeech, speak, stopSpeaking } from './voice';
import { generateText } from './localLlm';

export type SocraticState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface SocraticTurn {
  user: string;
  coach: string;
  at: string;
}

export interface SocraticSessionOptions {
  /** Optional grounding context (curriculum excerpts) prepended to the coach's system prompt. */
  groundingExcerpts?: string[];
  /** Override the system prompt entirely. */
  systemPrompt?: string;
  /** Maximum number of dialog turns to retain in the LLM context window. */
  maxTurns?: number;
  /** Wake-phrases that end the session (lowercased substring match against the user transcript). */
  stopPhrases?: string[];
  /** Override the LLM client (defaults to localLlm.generateText). Useful for tests. */
  generate?: (input: { prompt: string; system?: string }) => Promise<{ text: string }>;
}

export interface SocraticSessionHandle {
  /** Current state of the loop. */
  state: SocraticState;
  /** All completed turns in this session. */
  history: SocraticTurn[];
  /** Push the loop forward one turn (start listening). Returns when the turn settles. */
  next(): Promise<{ ended: boolean; reason?: string }>;
  /** Cancel any in-flight STT / LLM / TTS work and stop the session. */
  stop(): void;
  /** Subscribe to state-change events. */
  onState(cb: (s: SocraticState) => void): () => void;
  /** Subscribe to turn-completion events. */
  onTurn(cb: (turn: SocraticTurn) => void): () => void;
}

const DEFAULT_STOP_PHRASES = ['stop session', 'end session', 'stop listening', 'goodbye coach'];

const DEFAULT_SYSTEM = [
  'You are a CFA tutor having a SPOKEN conversation with a student.',
  'Keep replies under 60 words.  Prefer the Socratic method: ask a probing follow-up question whenever possible.',
  'No bullet lists, no markdown, no formulas in LaTeX — read formulas aloud in plain English.',
  'If the student asks you to stop or end the session, say goodbye and stop.',
].join(' ');

function isStopPhrase(transcript: string, phrases: string[]): boolean {
  const lower = transcript.trim().toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

/**
 * Open a Socratic loop session.  The session is "pull-based" — the caller
 * drives turns by repeatedly awaiting `next()`.  Useful for tying the loop
 * to a React effect that can also tear down on unmount.
 */
export function openSocraticSession(opts: SocraticSessionOptions = {}): SocraticSessionHandle {
  const stopPhrases = opts.stopPhrases ?? DEFAULT_STOP_PHRASES;
  const maxTurns = opts.maxTurns ?? 6;
  const generate = opts.generate ?? generateText;
  const systemBase = opts.systemPrompt ?? DEFAULT_SYSTEM;

  const systemPrompt = opts.groundingExcerpts && opts.groundingExcerpts.length
    ? `${systemBase}\n\nGrounded reference material:\n${opts.groundingExcerpts
        .map((s, i) => `[${i + 1}] ${s}`)
        .join('\n\n')}`
    : systemBase;

  const handle: SocraticSessionHandle = {
    state: 'idle',
    history: [],
    next: async () => ({ ended: true }),
    stop: () => {},
    onState: () => () => {},
    onTurn: () => () => {},
  };

  const stateListeners = new Set<(s: SocraticState) => void>();
  const turnListeners = new Set<(t: SocraticTurn) => void>();
  let abortController: AbortController | null = null;
  let stopped = false;

  function setState(s: SocraticState) {
    handle.state = s;
    for (const cb of stateListeners) cb(s);
  }

  handle.onState = (cb) => {
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  };
  handle.onTurn = (cb) => {
    turnListeners.add(cb);
    return () => turnListeners.delete(cb);
  };

  handle.stop = () => {
    stopped = true;
    abortController?.abort();
    try { stopSpeaking(); } catch { /* noop */ }
    setState('idle');
  };

  handle.next = async () => {
    if (stopped) return { ended: true, reason: 'already-stopped' };
    if (!hasSpeechRecognition()) return { ended: true, reason: 'no-speech-recognition' };

    abortController = new AbortController();

    // 1. LISTEN
    setState('listening');
    let userTranscript: string;
    try {
      const result = await recognizeOnce({ signal: abortController.signal });
      userTranscript = (result.transcript || '').trim();
    } catch (err) {
      setState('idle');
      const reason = err instanceof Error ? err.message : 'stt-failed';
      return { ended: true, reason };
    }
    if (!userTranscript) {
      setState('idle');
      return { ended: true, reason: 'empty-transcript' };
    }
    if (isStopPhrase(userTranscript, stopPhrases)) {
      setState('idle');
      return { ended: true, reason: 'user-stopped' };
    }

    // 2. THINK
    setState('thinking');
    const transcript = buildTranscript(handle.history, userTranscript, maxTurns);
    let coachText: string;
    try {
      const { text } = await generate({ prompt: transcript, system: systemPrompt });
      coachText = (text || '').trim();
    } catch (err) {
      setState('idle');
      const reason = err instanceof Error ? err.message : 'llm-failed';
      return { ended: true, reason };
    }
    if (!coachText) {
      setState('idle');
      return { ended: true, reason: 'empty-response' };
    }

    const turn: SocraticTurn = { user: userTranscript, coach: coachText, at: new Date().toISOString() };
    handle.history.push(turn);
    for (const cb of turnListeners) cb(turn);

    // 3. SPEAK
    if (hasSpeechSynthesis()) {
      setState('speaking');
      try {
        await speak(sanitizeForSpeech(coachText), { signal: abortController.signal });
      } catch {
        // ignore — could be a synthesis abort
      }
    }

    setState('idle');
    return { ended: false };
  };

  return handle;
}

function buildTranscript(history: SocraticTurn[], pending: string, maxTurns: number): string {
  const recent = history.slice(-maxTurns);
  const parts: string[] = [];
  for (const turn of recent) {
    parts.push(`Student: ${turn.user}`);
    parts.push(`Coach: ${turn.coach}`);
  }
  parts.push(`Student: ${pending}`);
  parts.push('Coach:');
  return parts.join('\n');
}
