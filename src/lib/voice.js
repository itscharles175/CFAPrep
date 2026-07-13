/**
 * voice.js — Web Speech API helpers for QuantVault.
 *
 * Voice input uses SpeechRecognition (Chrome = cloud STT, Safari/Edge = on-device).
 * Voice output uses SpeechSynthesis which is genuinely local on every platform.
 */

import { stripThink } from './stripThink';

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
  // Remove reasoning traces and [source:...] citation markers before TTS.
  return stripThink(String(text))
    .replace(/\[\s*source:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fully-offline speech recognition via @huggingface/transformers running
 * Whisper-tiny (~40 MB ONNX) entirely in-browser. The model is downloaded
 * once from the Hugging Face CDN on first use and cached in IndexedDB by
 * the transformers library; subsequent calls are local-only. There is no
 * cloud round-trip during recognition.
 *
 * Usage: hand it a Float32Array PCM 16 kHz mono audio buffer (captured
 * via MediaRecorder + an AudioContext.decodeAudioData pipeline) plus an
 * optional progress callback for the model-download phase.
 *
 * @param {{ audio: Float32Array, lang?: string, signal?: AbortSignal, onProgress?: Function }} options
 * @returns {Promise<{ transcript: string; engine: 'whisper-tiny-onnx' }>}
 */
export async function recognizeOnceOffline({ audio, lang = 'en', signal, onProgress }) {
  if (typeof window === 'undefined') throw new Error('Offline STT requires a browser environment.');
  if (!(audio instanceof Float32Array)) throw new Error('Offline STT requires a Float32Array audio buffer.');

  // Lazy import so the transformers bundle never loads on pages that don't use voice.
  const transformers = await import('@huggingface/transformers');
  const pipeline = transformers.pipeline ?? transformers.default?.pipeline;
  if (typeof pipeline !== 'function') throw new Error('Failed to load Whisper pipeline.');

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
    progress_callback: onProgress,
  });

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const result = await transcriber(audio, { language: lang, task: 'transcribe' });
  return {
    transcript: (result?.text || '').trim(),
    engine: 'whisper-tiny-onnx',
  };
}

/**
 * Record a chunk of microphone audio for the given duration (ms), then
 * resample to 16 kHz mono Float32 for Whisper. Uses MediaRecorder under
 * the hood. Cancellable via signal.
 *
 * @param {{ durationMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<Float32Array>}
 */
export async function recordAudioForOfflineStt({ durationMs = 8000, signal } = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is not available in this environment.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data?.size > 0) chunks.push(e.data);
    });

    const done = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', resolve);
      recorder.addEventListener('error', (e) => reject(e?.error || new Error('Recording failed')));
    });

    recorder.start();
    const timer = setTimeout(() => recorder.stop(), durationMs);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        try {
          recorder.stop();
        } catch {
          // already stopped
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    await done;
    clearTimeout(timer);

    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    // Mix to mono Float32.
    const channels = decoded.numberOfChannels;
    const len = decoded.length;
    const out = new Float32Array(len);
    for (let c = 0; c < channels; c += 1) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < len; i += 1) out[i] += data[i] / channels;
    }
    return out;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
