import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingOllamaStep } from "./onboarding-wizard";

const mocks = vi.hoisted(() => ({
  useAiHealth: vi.fn(),
  useSaveSettings: vi.fn(),
  saveMutation: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as { local_provider?: string } | undefined,
  },
}));

vi.mock("@lsat/lib/hooks", () => ({
  useAiHealth: mocks.useAiHealth,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useSaveSettings: mocks.useSaveSettings,
}));

function aiHealth(provider: "ollama" | "lmstudio") {
  return {
    data: {
      data: {
        ollama: provider === "ollama",
        ok: false,
        provider,
        local_provider: provider,
        models: [],
        explain_model: "qwen3:8b",
        gen_model: "qwen3:14b",
        missing_models: [],
      },
      usingSample: false,
    },
    isLoading: false,
  };
}

function renderStep() {
  render(<OnboardingOllamaStep onNext={vi.fn()} onSkip={vi.fn()} />);
}

describe("OnboardingOllamaStep provider selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveMutation.mutate.mockReset();
    mocks.saveMutation.isPending = false;
    mocks.saveMutation.variables = undefined;
    mocks.useAiHealth.mockReturnValue(aiHealth("ollama"));
    mocks.useSaveSettings.mockReturnValue(mocks.saveMutation);
  });

  it("ignores stale save variables after a failed provider change", () => {
    mocks.saveMutation.variables = { local_provider: "lmstudio" };

    renderStep();

    expect(
      screen.getByRole("heading", { name: "Local AI (Ollama)" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ollama not detected/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/LMStudio server not detected/i),
    ).not.toBeInTheDocument();
  });

  it("uses the requested provider while the save is pending", () => {
    mocks.saveMutation.isPending = true;
    mocks.saveMutation.variables = { local_provider: "lmstudio" };

    renderStep();

    expect(
      screen.getByRole("heading", { name: "Local AI (LMStudio)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/LMStudio server not detected/i),
    ).toBeInTheDocument();
  });
});
