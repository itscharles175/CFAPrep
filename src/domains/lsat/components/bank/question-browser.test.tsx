import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionBrowser } from "./question-browser";
import type { BrowseQuestion } from "@lsat/lib/bankBrowse";

const bankBrowseMocks = vi.hoisted(() => ({
  loadBankQuestions: vi.fn(),
  setBankQuestionsCache: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  question: vi.fn(),
}));

const mutationMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock("@lsat/lib/bankBrowse", async () => {
  const actual = await vi.importActual<typeof import("@lsat/lib/bankBrowse")>(
    "@lsat/lib/bankBrowse",
  );
  return {
    ...actual,
    loadBankQuestions: bankBrowseMocks.loadBankQuestions,
    setBankQuestionsCache: bankBrowseMocks.setBankQuestionsCache,
  };
});

vi.mock("@lsat/lib/api", () => ({
  api: {
    question: apiMocks.question,
  },
}));

vi.mock("@lsat/lib/mutations", () => ({
  useDeleteQuestion: () => mutationMocks,
}));

vi.mock("@lsat/components/bank/tag-editor", () => ({
  TagEditor: () => <div data-testid="tag-editor" />,
}));

vi.mock("@lsat/components/ui/virtual-list", () => ({
  VirtualList: <T,>({
    items,
    renderItem,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
  }) => <div>{items.map((item, index) => renderItem(item, index))}</div>,
}));

vi.mock("@lsat/components/ui/select", async () => {
  const ReactModule = await import("react");
  return {
    Select: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    SelectItem: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    SelectTrigger: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      ReactModule.createElement("button", { type: "button", ...props }, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) =>
      ReactModule.createElement("span", null, placeholder),
  };
});

function item(overrides: Partial<BrowseQuestion> = {}): BrowseQuestion {
  return {
    choices: [],
    correct_answer: "",
    difficulty: 3,
    id: 1,
    prompt: "Which option best resolves the paradox?",
    q_type: "Inference",
    source: "research",
    stem: "Question stem",
    training_eligible: true,
    training_notes: "usable",
    ...overrides,
  };
}

describe("QuestionBrowser a11y semantics", () => {
  beforeEach(() => {
    bankBrowseMocks.loadBankQuestions.mockReset();
    bankBrowseMocks.setBankQuestionsCache.mockReset();
    apiMocks.question.mockReset();
    mutationMocks.mutate.mockReset();
  });

  it("labels filters and keeps row actions outside the preview button", async () => {
    bankBrowseMocks.loadBankQuestions.mockResolvedValue([item()]);

    render(
      <MemoryRouter>
        <QuestionBrowser typeCounts={{ Inference: 1 }} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText("Browse questions")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("button", { name: "Question type filter" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Difficulty filter" }),
    ).toBeInTheDocument();

    const preview = screen.getByRole("button", {
      name: "Preview Inference question 1",
    });
    expect(preview).toBeInTheDocument();
    expect(preview.querySelector("button")).toBeNull();

    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete question 1" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[role="button"][tabindex="0"]')).toBeNull();
  });
});
