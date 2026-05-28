import { describe, it, expect, vi } from 'vitest';
import {
  hasSpeechRecognition,
  hasSpeechSynthesis,
  sanitizeForSpeech,
  recognizeOnce,
  speak,
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
