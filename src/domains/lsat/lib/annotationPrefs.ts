import type { Highlight } from "@lsat/components/question/highlightable-text";
import { getJSON, setJSON } from "./storage";

const PREFIX = "lsatlab.annotations.";

export function getQuestionAnnotations(questionId: number): Highlight[] {
  const arr = getJSON<Highlight[]>(PREFIX + questionId, []);
  return Array.isArray(arr) ? arr : [];
}

export function setQuestionAnnotations(
  questionId: number,
  highlights: Highlight[],
): void {
  setJSON(PREFIX + questionId, highlights);
}
