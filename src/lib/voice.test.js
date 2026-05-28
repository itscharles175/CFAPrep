import { describe, it, expect, vi } from 'vitest';
import {
  hasSpeechRecognition,
  hasSpeechSynthesis,
  sanitizeForSpeech,
  recognizeOnce,
  speak,
  recognizeOnceOffline,
  recordAudioForOfflineStt,
} from './voice.js';

// jsdom does not provide SpeechRecognition or speechSynthesis by default.

describe('hasSpeechRecognition', () => {
  it('returns false in jsdom (no SpeechRecognition global)', () => {
    expect(hasSpeechRecognition()).toBe(false);
  });
});

describe('hasSpeechSynthesis', () => {
  it('returns false in jsdom (no speechSynthesis global)', () => {
    expect(hasSpeechSynthesis()).toBe(false);
  });
});

describe('sanitizeForSpeech', () => {
  it('strips a standalone [source:abc] marker', () => {
    expect(sanitizeForSpeech('Hello [source:abc] world')).toBe('Hello world');
  });

  it('strips grouped markers like [source:abc, source:def]', () => {
    expect(sanitizeForSpeech('See this [source:abc, source:def] for details')).toBe('See this for details');
  });

  it('collapses extra whitespace left after stripping', () => {
    expect(sanitizeForSpeech('A  [source:x]  B')).toBe('A B');
  });

  it('handles multiple scattered markers', () => {
    const input = 'First point [source:aaa] is important. Second [source:bbb] too.';
    expect(sanitizeForSpeech(input)).toBe('First point is important. Second too.');
  });

  it('returns empty string for empty/falsy input', () => {
    expect(sanitizeForSpeech('')).toBe('');
    expect(sanitizeForSpeech(null)).toBe('');
    expect(sanitizeForSpeech(undefined)).toBe('');
  });

  it('leaves plain text unchanged', () => {
    expect(sanitizeForSpeech('No citations here.')).toBe('No citations here.');
  });
});

describe('recognizeOnce', () => {
  it('rejects with "Speech recognition is not supported" when SpeechRecognition is unavailable', async () => {
    // jsdom provides no SpeechRecognition; ensure neither variant is set
    const origSR = window.SpeechRecognition;
    const origWSR = window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;

    await expect(recognizeOnce()).rejects.toThrow('Speech recognition is not supported');

    // Restore
    if (origSR !== undefined) window.SpeechRecognition = origSR;
    if (origWSR !== undefined) window.webkitSpeechRecognition = origWSR;
  });

  it('resolves with transcript when SpeechRecognition is stubbed', async () => {
    const _listeners = {};
    class MockRecognition {
      constructor() {
        this.continuous = false;
        this.interimResults = false;
        this.lang = '';
      }
      start() {
        // Simulate async result
        setTimeout(() => {
          if (this.onresult) {
            this.onresult({ results: [[{ transcript: 'hello vitest' }]] });
          }
        }, 0);
      }
      abort() {}
    }

    vi.stubGlobal('SpeechRecognition', MockRecognition);
    try {
      const result = await recognizeOnce({ lang: 'en-US' });
      expect(result.transcript).toBe('hello vitest');
      expect(result.engine).toBe('browser-native');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects with AbortError when signal is already aborted', async () => {
    class MockRecognition {
      start() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition', MockRecognition);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(recognizeOnce({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('recognizeOnceOffline', () => {
  it('rejects when audio is not a Float32Array', async () => {
    // In jsdom, window is defined, so we only need to check the audio type guard.
    await expect(
      recognizeOnceOffline({ audio: [0.1, 0.2, 0.3] }),
    ).rejects.toThrow('Offline STT requires a Float32Array audio buffer.');
  });

  it('rejects with AbortError when given an already-aborted signal', async () => {
    // We need to get past the Float32Array check, so provide valid audio.
    // The lazy import of @huggingface/transformers will fail in jsdom (no
    // module bundler), but the aborted signal check runs before the pipeline
    // call, so we need to intercept the dynamic import instead.
    const controller = new AbortController();
    controller.abort();

    // Stub the import so it resolves before the aborted-signal guard fires.
    // The guard runs after the import resolves, so we mock a minimal pipeline.
    const mockPipeline = vi.fn();
    vi.doMock('@huggingface/transformers', () => ({ pipeline: mockPipeline }));

    // Use a real Float32Array so the first guard passes.
    const audio = new Float32Array([0.1, 0.2]);

    // Even with the mock, the aborted-signal check fires after import resolves.
    // Re-import voice.js dynamically so it picks up the mock.
    const { recognizeOnceOffline: fn } = await import('./voice.js?aborttest');
    await expect(fn({ audio, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    vi.doUnmock('@huggingface/transformers');
  });
});

describe('recordAudioForOfflineStt', () => {
  it('rejects with "Microphone access is not available" when navigator.mediaDevices is absent', async () => {
    // jsdom does not expose navigator.mediaDevices.getUserMedia by default.
    const origMD = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, writable: true, configurable: true });
    try {
      await expect(recordAudioForOfflineStt()).rejects.toThrow(
        'Microphone access is not available in this environment.',
      );
    } finally {
      if (origMD) {
        Object.defineProperty(navigator, 'mediaDevices', origMD);
      } else {
        delete navigator.mediaDevices;
      }
    }
  });
});

describe('speak', () => {
  it('rejects with "Speech synthesis is not supported" when speechSynthesis is unavailable', async () => {
    const orig = window.speechSynthesis;
    // Ensure speechSynthesis is not present
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, writable: true, configurable: true });

    await expect(speak('hello')).rejects.toThrow('Speech synthesis is not supported');

    // Restore
    Object.defineProperty(window, 'speechSynthesis', { value: orig, writable: true, configurable: true });
  });

  it('resolves when speechSynthesis.speak fires onend', async () => {
    let _capturedUtterance = null;
    const mockSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn((u) => {
        _capturedUtterance = u;
        setTimeout(() => u.onend && u.onend(), 0);
      }),
    };
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      constructor(text) { this.text = text; }
    });
    Object.defineProperty(window, 'speechSynthesis', { value: mockSynthesis, writable: true, configurable: true });

    try {
      await speak('test utterance', { lang: 'en-US', rate: 1.0 });
      expect(mockSynthesis.cancel).toHaveBeenCalled();
      expect(mockSynthesis.speak).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
