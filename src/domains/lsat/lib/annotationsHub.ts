// R7 6.2 — aggregation for the Annotations & notes review hub.
//
// Highlights, margin notes, and scratchpad text are all written to localStorage
// and (until now) were write-only: they only re-appeared inside the one question
// or section. This module reads them back across ALL sessions so they can be
// browsed.
//
// Storage contract (must match the writers):
//   highlights : "lsatlab.annotations.{questionId}" -> Highlight[]   (annotationPrefs.ts)
//   notes      : "lsatlab.notes.{questionId}"       -> MarginNote[]   (prefs.ts)
//   scratch    : "lsatlab.scratch.{sectionId}"      -> string         (scratchPrefs.ts)
//                "lsatlab.scratch.draw.{sectionId}" -> Stroke[]       (scratchPrefs.ts)
//
// Highlights + notes are keyed by QUESTION id and group together (and link to
// /explanation/{questionId}). Scratch is keyed by SECTION id and is grouped on
// its own (it has no single question to link to).

import type { Highlight } from "@lsat/components/question/highlightable-text";
import type { MarginNote } from "./prefs";

const ANNOT_PREFIX = "lsatlab.annotations.";
const NOTES_PREFIX = "lsatlab.notes.";
const SCRATCH_PREFIX = "lsatlab.scratch.";
const SCRATCH_DRAW_PREFIX = "lsatlab.scratch.draw.";

/** Per-question aggregation of highlights + margin notes. */
export interface QuestionAnnotations {
  questionId: number;
  highlights: Highlight[];
  notes: MarginNote[];
  /** Most recent note timestamp (ms), for sorting; 0 if none. */
  latest: number;
}

/** Per-section scratchpad text (drawing is summarized as a stroke count). */
export interface SectionScratch {
  sectionId: number;
  text: string;
  strokeCount: number;
}

export interface AnnotationsAggregate {
  questions: QuestionAnnotations[];
  scratch: SectionScratch[];
  /** True when there is nothing at all to show. */
  isEmpty: boolean;
}

/** Minimal Storage shape so this is testable without a real localStorage. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function idFromKey(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

/**
 * Read every annotation/note/scratch entry out of a storage and group them.
 * Pure over the passed storage; defaults to `window.localStorage` at call time.
 * Questions are sorted by most-recent note first (then by id); empty entries
 * are dropped.
 */
export function aggregateAnnotations(storage?: StorageLike): AnnotationsAggregate {
  const store: StorageLike | undefined =
    storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return { questions: [], scratch: [], isEmpty: true };

  const byQuestion = new Map<number, QuestionAnnotations>();
  const ensure = (qid: number): QuestionAnnotations => {
    let q = byQuestion.get(qid);
    if (!q) {
      q = { questionId: qid, highlights: [], notes: [], latest: 0 };
      byQuestion.set(qid, q);
    }
    return q;
  };

  const scratchText = new Map<number, string>();
  const scratchStrokes = new Map<number, number>();

  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;

    // Order matters: the draw prefix is a superset of the scratch prefix, so
    // test it first.
    const drawId = idFromKey(key, SCRATCH_DRAW_PREFIX);
    if (drawId != null) {
      const strokes = parse<unknown[]>(store.getItem(key), []);
      if (Array.isArray(strokes) && strokes.length) scratchStrokes.set(drawId, strokes.length);
      continue;
    }
    const scratchId = idFromKey(key, SCRATCH_PREFIX);
    if (scratchId != null) {
      const text = store.getItem(key) ?? "";
      if (text.trim()) scratchText.set(scratchId, text);
      continue;
    }
    const annotId = idFromKey(key, ANNOT_PREFIX);
    if (annotId != null) {
      const hls = parse<Highlight[]>(store.getItem(key), []);
      if (Array.isArray(hls) && hls.length) ensure(annotId).highlights = hls;
      continue;
    }
    const noteId = idFromKey(key, NOTES_PREFIX);
    if (noteId != null) {
      const notes = parse<MarginNote[]>(store.getItem(key), []);
      if (Array.isArray(notes) && notes.length) {
        const q = ensure(noteId);
        q.notes = notes;
        q.latest = notes.reduce((m, n) => Math.max(m, n.createdAt ?? 0), q.latest);
      }
      continue;
    }
  }

  const questions = [...byQuestion.values()]
    .filter((q) => q.highlights.length > 0 || q.notes.length > 0)
    .sort((a, b) => b.latest - a.latest || b.questionId - a.questionId);

  const sectionIds = new Set<number>([...scratchText.keys(), ...scratchStrokes.keys()]);
  const scratch: SectionScratch[] = [...sectionIds]
    .map((sectionId) => ({
      sectionId,
      text: scratchText.get(sectionId) ?? "",
      strokeCount: scratchStrokes.get(sectionId) ?? 0,
    }))
    .filter((s) => s.text.trim().length > 0 || s.strokeCount > 0)
    .sort((a, b) => b.sectionId - a.sectionId);

  return {
    questions,
    scratch,
    isEmpty: questions.length === 0 && scratch.length === 0,
  };
}
