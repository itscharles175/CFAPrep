import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingOllamaStep, examCountdownPresentation, onboardingAppliesToRoute, setFirstLightChromeState } from "./onboarding-wizard";

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

describe("onboarding route eligibility", () => {
  it("keeps first-light setup on LSAT learn surfaces without covering deep links", () => {
    expect(onboardingAppliesToRoute("/")).toBe(true);
    expect(onboardingAppliesToRoute("/dashboard")).toBe(true);
    expect(onboardingAppliesToRoute("/tutor")).toBe(false);
    expect(onboardingAppliesToRoute("/practice")).toBe(false);
  });

  it("does not invent a zero-day deadline before an exam date is chosen", () => {
    expect(examCountdownPresentation(null)).toEqual({
      label: "Exam date",
      value: null,
      status: "Not set",
    });
    expect(examCountdownPresentation(27)).toMatchObject({
      label: "Days to exam",
      value: 27,
    });
    expect(examCountdownPresentation(-2)).toMatchObject({
      label: "Exam date passed",
      value: 0,
    });
  });

  it("marks first light as the active screen so background diagnostics can be suppressed", () => {
    setFirstLightChromeState(true);
    expect(document.documentElement.dataset.lsatFirstLight).toBe("active");

    setFirstLightChromeState(false);
    expect(document.documentElement.dataset.lsatFirstLight).toBeUndefined();
  });
});

afterEach(() => setFirstLightChromeState(false));
