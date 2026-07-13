import { api } from "./api";
import type { Question } from "./types";
import { sampleSectionLR } from "./sample";

// Browse rows from GET /api/bank/questions are a lightweight projection: they
// carry previews + provenance but not the section/passage anchoring of a full
// Question, so those are optional here.
export interface BrowseQuestion
  extends Omit<Question, "section_id" | "passage_id"> {
  section_id?: number | null;
  passage_id?: number | null;
  preptestName?: string;
  sectionType?: string;
  /** Bank-browse provenance metadata (from GET /api/bank/questions). */
  quarantined?: boolean;
  approved?: boolean;
}

/** Flatten bank export payload into browsable questions. */
export function flattenBankExport(payload: Record<string, unknown>): BrowseQuestion[] {
  const out: BrowseQuestion[] = [];
  const pts = payload.preptests as
    | { name?: string; sections?: { type?: string; questions?: Question[] }[] }[]
    | undefined;
  if (pts) {
    for (const pt of pts) {
      for (const sec of pt.sections ?? []) {
        for (const q of sec.questions ?? []) {
          out.push({
            ...q,
            preptestName: pt.name,
            sectionType: sec.type,
          });
        }
      }
    }
  }
  const unsectioned = payload.unsectioned_questions as Question[] | undefined;
  if (unsectioned) {
    for (const q of unsectioned) {
      out.push({ ...q, preptestName: "Unsectioned" });
    }
  }
  return out;
}

const SAMPLE_BROWSE: BrowseQuestion[] = (sampleSectionLR.questions ?? []).map(
  (q: Question, i: number) => ({
    ...q,
    id: q.id || 100 + i,
    preptestName: "Sample Diagnostic",
    sectionType: sampleSectionLR.type,
  }),
);

let cache: BrowseQuestion[] | null = null;

export function setBankQuestionsCache(next: BrowseQuestion[]) {
  cache = next;
}

export async function loadBankQuestions(force = false): Promise<BrowseQuestion[]> {
  if (cache && !force) return cache;
  try {
    const out: BrowseQuestion[] = [];
    let cursor: number | undefined;
    const limit = 200;
    while (true) {
      const page = await api.bankQuestions({ cursor, limit });
      for (const row of page.items) {
        out.push({
          id: row.id,
          q_type: row.q_type,
          difficulty: row.difficulty,
          source: row.source as Question["source"],
          stem: row.stem_preview,
          prompt: row.prompt_preview,
          correct_answer: "",
          choices: [],
          quarantined: row.quarantined,
          approved: row.approved,
          training_eligible: row.training_eligible,
          training_notes: row.training_notes ?? undefined,
        });
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    cache = out.length ? out : SAMPLE_BROWSE;
  } catch {
    cache = SAMPLE_BROWSE;
  }
  return cache;
}
