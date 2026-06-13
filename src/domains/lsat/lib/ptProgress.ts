import { getJSON, setJSON } from "./storage";

const PREFIX = "lsatlab.ptProgress.";

export interface PtProgress {
  bestScore: number | null;
  sectionsCompleted: number;
}

const EMPTY: PtProgress = { bestScore: null, sectionsCompleted: 0 };

export function getPtProgress(ptId: number): PtProgress {
  return getJSON<PtProgress>(PREFIX + ptId, EMPTY);
}

export function recordPtSectionComplete(
  ptId: number,
  scaledScore: number | null,
  sectionsDone: number,
): void {
  const prev = getPtProgress(ptId);
  setPtProgress(ptId, {
    bestScore:
      scaledScore != null
        ? Math.max(prev.bestScore ?? 0, scaledScore)
        : prev.bestScore,
    sectionsCompleted: Math.max(prev.sectionsCompleted, sectionsDone),
  });
}

function setPtProgress(ptId: number, p: PtProgress): void {
  setJSON(PREFIX + ptId, p);
}
