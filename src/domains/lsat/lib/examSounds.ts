import { STORAGE_KEYS, getRaw, setRaw } from "./storage";

const K_EXAM_SOUNDS = STORAGE_KEYS.examSounds;

/** R4-C11 — optional section-end chime (off by default). */
export function getExamSoundsEnabled(): boolean {
  return getRaw(K_EXAM_SOUNDS) === "1";
}

export function setExamSoundsEnabled(on: boolean): void {
  setRaw(K_EXAM_SOUNDS, on ? "1" : "0");
}

let audioCtx: AudioContext | null = null;

/** Short beep via Web Audio API when section finishes. */
export function playSectionEndBeep(): void {
  if (!getExamSoundsEnabled()) return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  } catch {
    /* autoplay policy or unsupported */
  }
}
