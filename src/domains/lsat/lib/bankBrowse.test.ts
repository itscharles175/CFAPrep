import { describe, expect, it, vi } from "vitest";

const { bankQuestionsMock } = vi.hoisted(() => ({
  bankQuestionsMock: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    bankQuestions: bankQuestionsMock,
  },
}));

import { loadBankQuestions } from "./bankBrowse";

function row(id: number) {
  return {
    id,
    q_type: "Inference",
    difficulty: 3,
    source: "sample",
    stem_preview: `stem ${id}`,
    prompt_preview: `prompt ${id}`,
    quarantined: false,
    approved: true,
    training_eligible: false,
    training_notes: null,
  };
}

describe("loadBankQuestions", () => {
  it("walks the bank by cursor instead of deep offsets", async () => {
    bankQuestionsMock
      .mockResolvedValueOnce({
        total: 3,
        offset: 0,
        limit: 2,
        cursor: null,
        next_cursor: 2,
        has_more: true,
        items: [row(1), row(2)],
      })
      .mockResolvedValueOnce({
        total: 3,
        offset: 0,
        limit: 2,
        cursor: 2,
        next_cursor: null,
        has_more: false,
        items: [row(3)],
      });

    const rows = await loadBankQuestions(true);

    expect(rows.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(bankQuestionsMock).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 200,
    });
    expect(bankQuestionsMock).toHaveBeenNthCalledWith(2, {
      cursor: 2,
      limit: 200,
    });
  });
});
