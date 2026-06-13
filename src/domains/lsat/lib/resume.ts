/** Persist in-progress study positions for resume UX (R4-B2). */

import { STORAGE_KEYS, getJSON, remove, setJSON } from "./storage";

const K_RESUME = STORAGE_KEYS.resume;

export type ResumeKind = "exam" | "section" | "blind-review" | "drill";

export interface ResumePointer {
  kind: ResumeKind;
  label: string;
  path: string;
  /** Question index within section/BR. */
  index?: number;
  updatedAt: string;
}

export function getResume(): ResumePointer | null {
  return getJSON<ResumePointer | null>(K_RESUME, null);
}

export function setResume(ptr: ResumePointer): void {
  setJSON(K_RESUME, ptr);
}

export function clearResume(): void {
  remove(K_RESUME);
}
