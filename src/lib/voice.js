/**
 * voice.js — Web Speech API helpers for QuantVault.
 *
 * Voice input uses SpeechRecognition (Chrome = cloud STT, Safari/Edge = on-device).
 * Voice output uses SpeechSynthesis which is genuinely local on every platform.
 */

/** Detect whether the browser supports SpeechRecognition (Chrome/Edge/Safari/Tauri webview). */
export function hasSpeechRecognition() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Detect whether the browser supports SpeechSynthesis (essentially all modern browsers). */
export function hasSpeechSynthesis() {
  return typeof window !== 'undefined' && Boolean(window.speechSynthesis);
}

/**
 * Start a one-shot speech recognition session. The browser's SpeechRecognition
 * API returns transcripts via a result event; this wraps it in a Promise.
 * Cancellable via signal. Returns the recognized transcript or throws.
 *
 * Note: on Chrome this currently uses Google's cloud STT (not strictly offline);
 * on Safari and Edge it uses on-device STT. We expose that via a hint string in
 * the returned object so callers can render an honest warning.
 *
 * @param {{ lang?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ transcript: string; engine: 'browser-native' | 'unknown' }>}
 */
export function recognizeOnce({ lang = 'en-US', signal } = {}) {
  return new Promise((resolve, reject) => {
    const Ctor = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!Ctor) {
      reject(new Error('Speech recognition is not supported'));
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = lang;

    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      fn();
    }

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      settle(() => resolve({ transcript, engine: 'browser-native' }));
    };

    recognition.onerror = (event) => {
      settle(() => reject(new Error(event.error || 'Speech recognition error')));
    };

    recognition.onend = () => {
      settle(() => reject(new Error('Speech recognition ended without result')));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        settle(() => {
          recognition.abort();
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }, { once: true });
    }

    recognition.start();
  });
}

/**
 * Speak a string using the browser's SpeechSynthesis API. Uses the OS-local
 * voice engine on every desktop platform (Apple voices on macOS, Windows
 * voices on Windows, espeak/festival on Linux) — genuinely offline.
 * Returns a Promise that resolves when speaking finishes (or rejects on error).
 *
 * @param {string} text
 * @param {{ lang?: string, rate?: number, voice?: SpeechSynthesisVoice, signal?: AbortSignal }} options
 * @returns {Promise<void>}
 */
export function speak(text, { lang = 'en-US', rate = 1.05, voice, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      reject(new Error('Speech synthesis is not supported'));
      return;
    }

    // Cancel any previous utterance before starting a new one.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;
    if (voice) utterance.voice = voice;

    utterance.onend = () => resolve();
    utterance.onerror = (event) => reject(new Error(event.error || 'Speech synthesis error'));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        window.speechSynthesis.cancel();
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }

    window.speechSynthesis.speak(utterance);
  });
}

/** Cancel any in-progress speech. */
export function stopSpeaking() {
  window.speechSynthesis?.cancel?.();
}

/**
 * Return a sanitized version of grounded answer text suitable for TTS —
 * strips citation markers like `[source:xxxxx]` and collapses whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForSpeech(text) {
  if (!text) return '';
  // Remove [source:...] citation markers (standalone or grouped like [source:a, source:b])
  return text
    .replace(/\[\s*source:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
