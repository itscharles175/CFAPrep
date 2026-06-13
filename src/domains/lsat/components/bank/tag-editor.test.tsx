import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagEditor } from "./tag-editor";
import type { BrowseQuestion } from "@/lib/bankBrowse";

const apiMocks = vi.hoisted(() => ({
  bankBulkTag: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    bankBulkTag: apiMocks.bankBulkTag,
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: toastMocks,
}));

vi.mock("@/components/ui/select", async () => {
  const ReactModule = await import("react");
  const SelectContext = ReactModule.createContext<{
    onValueChange: (value: string) => void;
  }>({ onValueChange: () => {} });

  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string) => void;
      value: string;
    }) =>
      ReactModule.createElement(
        SelectContext.Provider,
        { value: { onValueChange } },
        ReactModule.createElement("div", null, children),
      ),
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    SelectItem: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const context = ReactModule.useContext(SelectContext);
      return ReactModule.createElement(
        "button",
        {
          onClick: () => context.onValueChange(value),
          type: "button",
        },
        children,
      );
    },
    SelectTrigger: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectValue: () => null,
  };
});

function item(overrides: Partial<BrowseQuestion> = {}): BrowseQuestion {
  return {
    choices: [],
    correct_answer: "",
    difficulty: 3,
    id: 1,
    prompt: "Question prompt",
    q_type: "Inference",
    source: "research",
    stem: "Question stem",
    ...overrides,
  };
}

describe("TagEditor", () => {
  beforeEach(() => {
    apiMocks.bankBulkTag.mockReset();
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
  });

  it("persists bulk tag edits before updating the local table", async () => {
    const items = [item({ id: 1 }), item({ id: 2 })];
    const onUpdated = vi.fn();
    apiMocks.bankBulkTag.mockResolvedValue({ updated: 2 });

    render(<TagEditor items={items} filtered={items} onUpdated={onUpdated} />);

    fireEvent.click(screen.getByRole("button", { name: "Flaw" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to filtered" }));

    await waitFor(() =>
      expect(apiMocks.bankBulkTag).toHaveBeenCalledWith({
        question_ids: [1, 2],
        q_type: "Flaw",
      }),
    );
    expect(onUpdated).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, q_type: "Flaw" }),
      expect.objectContaining({ id: 2, q_type: "Flaw" }),
    ]);
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Updated 2 questions on the server.",
    );
  });

  it("does not apply local-only edits when persistence fails", async () => {
    const items = [item({ id: 1 })];
    const onUpdated = vi.fn();
    apiMocks.bankBulkTag.mockRejectedValue(new Error("offline"));

    render(<TagEditor items={items} filtered={items} onUpdated={onUpdated} />);

    fireEvent.click(screen.getByRole("button", { name: "Flaw" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to filtered" }));

    await waitFor(() => expect(apiMocks.bankBulkTag).toHaveBeenCalled());
    expect(onUpdated).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      "Could not save tags — no local-only edits were applied.",
    );
  });
});
