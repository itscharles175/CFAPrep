import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeakTypeRecommender } from "../weak-type-recommender";

const mocks = vi.hoisted(() => ({
  useWeakTypeSuggestions: vi.fn(),
  mutate: vi.fn(),
  navigate: vi.fn(),
  isPending: false,
}));

vi.mock("@lsat/lib/hooks", () => ({
  useWeakTypeSuggestions: mocks.useWeakTypeSuggestions,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useCreateDrill: () => ({ mutate: mocks.mutate, isPending: mocks.isPending }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => mocks.navigate };
});

function suggestionPayload() {
  return {
    data: {
      data: {
        count: 1,
        suggestions: [
          {
            q_type: "Weaken",
            section_type: "LR",
            mastery: 0.32,
            accuracy: 0.41,
            evidence_n: 18,
            avg_time_ms: 98000,
            drill: {
              q_type: "Weaken",
              section_type: "LR",
              count: 10,
              source: "any",
              timed: true,
              weak_type_remediation: true,
            },
          },
        ],
      },
      usingSample: false,
    },
    isLoading: false,
  };
}

function renderCard() {
  return render(
    <MemoryRouter>
      <WeakTypeRecommender />
    </MemoryRouter>,
  );
}

describe("WeakTypeRecommender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useWeakTypeSuggestions.mockReturnValue(suggestionPayload());
  });

  it("lists the weakest type with its accuracy", () => {
    renderCard();
    expect(screen.getByText("Weak-type drills")).toBeInTheDocument();
    expect(screen.getByText("Weaken")).toBeInTheDocument();
    expect(screen.getByText("41% accuracy")).toBeInTheDocument();
  });

  it("starts a weak-type-remediation drill and navigates to the session runner", async () => {
    mocks.mutate.mockImplementation((_config, opts) =>
      opts?.onSuccess?.({ session_id: 77, questions: [] }),
    );
    renderCard();

    await userEvent.click(
      screen.getByRole("button", { name: /Start weak-type drill for Weaken/i }),
    );

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          q_type: "Weaken",
          section_type: "LR",
          weak_type_remediation: true,
          source: "any",
          timed: true,
        }),
        expect.any(Object),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/take/session/77");
  });

  it("shows an empty state when no weak types are available", () => {
    mocks.useWeakTypeSuggestions.mockReturnValue({
      data: { data: { count: 0, suggestions: [] }, usingSample: false },
      isLoading: false,
    });
    renderCard();
    expect(
      screen.getByText("Complete a few drills to surface your weakest types."),
    ).toBeInTheDocument();
  });
});
