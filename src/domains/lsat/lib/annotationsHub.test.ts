import { describe, it, expect } from "vitest";
import { aggregateAnnotations, type StorageLike } from "./annotationsHub";

/** Minimal in-memory Storage for testing the aggregation. */
function fakeStorage(entries: Record<string, string>): StorageLike {
  const keys = Object.keys(entries);
  return {
    get length() {
      return keys.length;
    },
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => (k in entries ? entries[k] : null),
  };
}

describe("aggregateAnnotations", () => {
  it("reports empty when storage has nothing relevant", () => {
    const agg = aggregateAnnotations(fakeStorage({ "unrelated.key": "x" }));
    expect(agg.isEmpty).toBe(true);
    expect(agg.questions).toEqual([]);
    expect(agg.scratch).toEqual([]);
  });

  it("groups highlights and notes by question id", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.annotations.101": JSON.stringify([
          { start: 0, end: 5, color: "yellow" },
        ]),
        "lsatlab.notes.101": JSON.stringify([
          { id: "n1", start: 0, end: 4, quote: "Some", body: "a note", createdAt: 100 },
        ]),
      }),
    );
    expect(agg.isEmpty).toBe(false);
    expect(agg.questions).toHaveLength(1);
    const q = agg.questions[0];
    expect(q.questionId).toBe(101);
    expect(q.highlights).toHaveLength(1);
    expect(q.notes).toHaveLength(1);
    expect(q.latest).toBe(100);
  });

  it("sorts questions by most-recent note first", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.notes.1": JSON.stringify([
          { id: "a", start: 0, end: 1, quote: "", body: "old", createdAt: 10 },
        ]),
        "lsatlab.notes.2": JSON.stringify([
          { id: "b", start: 0, end: 1, quote: "", body: "new", createdAt: 999 },
        ]),
      }),
    );
    expect(agg.questions.map((q) => q.questionId)).toEqual([2, 1]);
  });

  it("collects scratch text + drawing strokes by section id, separate from questions", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.scratch.11": "diagram: A -> B",
        "lsatlab.scratch.draw.11": JSON.stringify([
          { points: [{ x: 0, y: 0 }] },
          { points: [{ x: 1, y: 1 }] },
        ]),
      }),
    );
    expect(agg.questions).toEqual([]);
    expect(agg.scratch).toHaveLength(1);
    expect(agg.scratch[0]).toEqual({
      sectionId: 11,
      text: "diagram: A -> B",
      strokeCount: 2,
    });
  });

  it("drops empty highlight arrays, empty notes, and blank scratch", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.annotations.5": "[]",
        "lsatlab.notes.6": "[]",
        "lsatlab.scratch.7": "   ",
      }),
    );
    expect(agg.isEmpty).toBe(true);
  });

  it("ignores malformed JSON without throwing", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.annotations.9": "{not json",
        "lsatlab.notes.9": "also bad",
      }),
    );
    expect(agg.isEmpty).toBe(true);
  });

  it("does not treat draw keys as plain scratch (prefix overlap)", () => {
    const agg = aggregateAnnotations(
      fakeStorage({
        "lsatlab.scratch.draw.3": JSON.stringify([{ points: [] }]),
      }),
    );
    // Only a stroke count, no spurious text entry.
    expect(agg.scratch).toHaveLength(1);
    expect(agg.scratch[0].sectionId).toBe(3);
    expect(agg.scratch[0].strokeCount).toBe(1);
    expect(agg.scratch[0].text).toBe("");
  });
});
