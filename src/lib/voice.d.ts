export interface SpeechResult {
  transcript: string;
  engine?: string;
}

export interface RecognizeOnceOptions {
  lang?: string;
  signal?: AbortSignal;
}

export interface RecognizeOnceOfflineOptions extends RecognizeOnceOptions {
  audio: Float32Array;
  onProgress?: (progress: unknown) => void;
}

export interface SpeakOptions {
  signal?: AbortSignal;
  rate?: number;
}

export function hasSpeechRecognition(): boolean;
export function hasSpeechSynthesis(): boolean;
export function recognizeOnce(options?: RecognizeOnceOptions): Promise<SpeechResult>;
export function speak(text: string, options?: SpeakOptions): Promise<void>;
export function stopSpeaking(): void;
export function sanitizeForSpeech(text: string): string;
export function recognizeOnceOffline(options: RecognizeOnceOfflineOptions): Promise<SpeechResult>;
export function recordAudioForOfflineStt(options?: { signal?: AbortSignal }): Promise<Float32Array>;
