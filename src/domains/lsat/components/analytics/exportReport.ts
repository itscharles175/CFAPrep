import type {
  BlindReviewGap,
  ByTypeRow,
  DifficultyRow,
  TrapRow,
} from "@/lib/types";

export interface ReportSnapshot {
  generatedAt: string;
  source: "official" | "all";
  range: string;
  kpis: {
    predictedScore: number | null;
    scoreDelta30d: number | null;
    accuracy: number;
    avgTimeMsPerQ: number;
    brGap: number;
  };
  byType: ByTypeRow[];
  blindReviewGap: BlindReviewGap;
  difficulty: DifficultyRow[];
  traps: TrapRow[];
}

/** §3.10 — download a clean JSON snapshot of the current analytics. */
export function downloadReport(snapshot: ReportSnapshot): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = snapshot.generatedAt.slice(0, 10);
  a.href = url;
  a.download = `lsatlab-analytics-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** §3.10 — trigger the browser print dialog for a print-friendly recap. */
export function printReport(): void {
  window.print();
}
