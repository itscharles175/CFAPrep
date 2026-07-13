// LSAT-2 — trap-keyed RAG types.
//
// The backend's `trap_similar_misses_for_question` (services/lsat-backend/
// app/embeddings.py) returns one record per recent miss that shares the active
// trap pattern. The `/ai/explain` SSE `done` event carries them as an optional
// `trap_patterns` envelope so the explanation can surface a "See trap patterns"
// accordion ("you fell for this reversal on Q31, Q18"). Every field is optional
// or nullable to stay backward-compatible and tolerant of partial wire shapes.

/** One recurring trap a prior miss fell into, keyed by question. */
export interface TrapPattern {
  /** The attempt id of the prior miss (stable key). */
  attempt_id?: number | null;
  /** The question the student previously missed with this trap. */
  question_id: number;
  /** Question type label (e.g. "Flaw", "Strengthen"). */
  q_type?: string | null;
  /** The trap type that snared the student (e.g. "reversal"). */
  trap_type?: string | null;
  /** The wrong choice the student picked on that prior miss. */
  chosen_answer?: string | null;
  /** How the miss was matched: trap_type | question_trap | q_type_trap. */
  matched_by?: string | null;
  /** Cached cosine similarity to the current question, when available. */
  similarity?: number | null;
  /** A short excerpt of the student's own note on that miss, when present. */
  note_excerpt?: string | null;
  /** ISO timestamp of the prior attempt. */
  created_at?: string | null;
}

/** The `trap_patterns` envelope carried on the explain `done` SSE event. */
export interface TrapPatternsMeta {
  count: number;
  items: TrapPattern[];
}
