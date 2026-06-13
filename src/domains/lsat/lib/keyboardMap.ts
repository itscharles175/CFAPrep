/** Exam keyboard bindings (persisted in localStorage). */

import { STORAGE_KEYS, getJSON, setJSON } from "./storage";

const K_KEYBOARD = STORAGE_KEYS.keyboardMap;

export type ExamKeyAction =
  | "answer_A"
  | "answer_B"
  | "answer_C"
  | "answer_D"
  | "answer_E"
  | "flag"
  | "prev"
  | "next";

export type KeyboardMap = Record<ExamKeyAction, string>;

export const DEFAULT_KEYBOARD_MAP: KeyboardMap = {
  answer_A: "a",
  answer_B: "b",
  answer_C: "c",
  answer_D: "d",
  answer_E: "e",
  flag: "f",
  prev: "ArrowLeft",
  next: "ArrowRight",
};

const LABELS: Record<ExamKeyAction, string> = {
  answer_A: "Select A",
  answer_B: "Select B",
  answer_C: "Select C",
  answer_D: "Select D",
  answer_E: "Select E",
  flag: "Flag question",
  prev: "Previous question",
  next: "Next question",
};

export function actionLabel(action: ExamKeyAction): string {
  return LABELS[action];
}

export function getKeyboardMap(): KeyboardMap {
  const parsed = getJSON<Partial<KeyboardMap>>(K_KEYBOARD, {});
  return { ...DEFAULT_KEYBOARD_MAP, ...parsed };
}

export function setKeyboardMap(map: KeyboardMap): void {
  setJSON(K_KEYBOARD, map);
}

export function resetKeyboardMap(): KeyboardMap {
  setKeyboardMap({ ...DEFAULT_KEYBOARD_MAP });
  return getKeyboardMap();
}

function keysMatch(pressed: string, bound: string): boolean {
  if (!bound) return false;
  if (bound.startsWith("Arrow")) return pressed === bound;
  if (pressed.length === 1 && bound.length === 1) {
    return pressed.toLowerCase() === bound.toLowerCase();
  }
  return pressed === bound;
}

/** Resolve a keydown event to an exam action (or null). */
export function resolveExamKey(
  e: KeyboardEvent,
  map: KeyboardMap,
): ExamKeyAction | "eliminate" | null {
  const key = e.key;
  if (e.shiftKey && keysMatch(key, map.answer_E)) return "eliminate";
  for (const [action, bound] of Object.entries(map) as [ExamKeyAction, string][]) {
    if (keysMatch(key, bound)) return action;
  }
  if (key >= "1" && key <= "9") return null; // numeric jump handled separately
  return null;
}

export function answerLabelFromAction(
  action: ExamKeyAction,
): string | null {
  if (action.startsWith("answer_")) return action.slice(7);
  return null;
}

/**
 * Blind Review keyboard actions (1.6). BR reuses the answer bindings from the
 * shared map (so A–E stay consistent with the timed runner) and adds:
 *   - 1 / 2 / 3 → confidence (sure / likely / guess)
 *   - r or Enter → reveal (caller gates on whether reveal is allowed)
 * Arrow navigation is handled by the caller as before.
 */
export type BrConfidence = "sure" | "likely" | "guess";

export type BrKeyAction =
  | { kind: "answer"; label: string }
  | { kind: "confidence"; value: BrConfidence }
  | { kind: "reveal" };

const CONFIDENCE_BY_DIGIT: Record<string, BrConfidence> = {
  "1": "sure",
  "2": "likely",
  "3": "guess",
};

export function resolveBrKey(
  e: KeyboardEvent,
  map: KeyboardMap,
): BrKeyAction | null {
  if (e.key === "Enter" || e.key === "r" || e.key === "R") {
    return { kind: "reveal" };
  }
  const conf = CONFIDENCE_BY_DIGIT[e.key];
  if (conf) return { kind: "confidence", value: conf };
  // Answer letters via the shared bindings (skip the eliminate/flag/nav ones).
  const resolved = resolveExamKey(e, map);
  if (resolved && resolved !== "eliminate") {
    const label = answerLabelFromAction(resolved);
    if (label) return { kind: "answer", label };
  }
  return null;
}
