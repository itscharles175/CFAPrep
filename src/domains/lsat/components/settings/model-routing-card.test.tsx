import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test/setup";
import type { AiHealth, ObservabilityStatus, Settings } from "@/lib/types";
import {
  isLoopbackLmsUrl,
  ModelRolePicker,
  ModelRoutingCard,
} from "./model-routing-card";

const mocks = vi.hoisted(() => ({
  useAiHealth: vi.fn(),
  useObservability: vi.fn(),
  useSettings: vi.fn(),
  useSaveSettings: vi.fn(),
  usePregenerate: vi.fn(),
  saveCall: 0,
  providerMutation: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as { local_provider?: string } | undefined,
  },
  urlMutation: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as Record<string, unknown> | undefined,
  },
  modelMutation: {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined as Record<string, unknown> | undefined,
  },
  pregenMutation: {
    mutate: vi.fn(),
    isPending: false,
  },
}));

vi.mock("@/lib/hooks", () => ({
  useAiHealth: mocks.useAiHealth,
  useObservability: mocks.useObservability,
  useSettings: mocks.useSettings,
}));

vi.mock("@/lib/mutations", () => ({
  useSaveSettings: mocks.useSaveSettings,
  usePregenerate: mocks.usePregenerate,
}));

function providerInfo(provider: "ollama" | "lmstudio") {
  return {
    realtime_provider: provider,
    local_provider: provider,
    lmstudio_url: "http://localhost:1234/v1",
    offline_provider: provider,
    cloud_enabled: false,
    explain_model: "qwen3:8b",
    gen_model: "qwen3:14b",
    critic_model: "qwen3:14b",
    diagnose_model: "qwen3:8b",
    embed_model: "nomic-embed-text",
    cloud_gen_model: null,
  };
}

function health(
  provider: "ollama" | "lmstudio",
  overrides: Partial<AiHealth> = {},
) {
  return {
    data: {
      data: {
        ollama: provider === "ollama",
        ok: true,
        provider,
        local_provider: provider,
        lmstudio_url: "http://localhost:1234/v1",
        models: [],
        explain_model: "qwen3:8b",
        gen_model: "qwen3:14b",
        missing_models: [],
        ...overrides,
      } satisfies AiHealth,
      usingSample: false,
    },
  };
}

function settings(
  provider: "ollama" | "lmstudio",
  overrides: Partial<Settings["settings"]> = {},
) {
  return {
    data: {
      data: {
        settings: {
          explain_model: "qwen3:8b",
          gen_model: "qwen3:14b",
          diagnose_model: "qwen3:8b",
          embed_model: "nomic-embed-text",
          gen_provider: "local",
          cloud_gen_model: "claude-3-5-sonnet",
          gen_critic_model: "qwen3:14b",
          local_provider: provider,
          lmstudio_url: "http://localhost:1234/v1",
          ...overrides,
        },
        provider: providerInfo(provider),
      } satisfies Settings,
      usingSample: false,
    },
  };
}

function observability(provider: "ollama" | "lmstudio") {
  return {
    data: {
      data: {
        gen_queued: 0,
        gen_running: 0,
        worker_alive: true,
        last_coach_refresh_ms: null,
        explain_p50_ms: null,
        embed_coverage_pct: 0,
        models: providerInfo(provider),
      } satisfies ObservabilityStatus,
      usingSample: false,
    },
  };
}

function resetMutation(mutation: typeof mocks.providerMutation) {
  mutation.mutate.mockReset();
  mutation.isPending = false;
  mutation.variables = undefined;
}

function renderCard() {
  mocks.saveCall = 0;
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ModelRoutingCard />
    </QueryClientProvider>,
  );
}

describe("ModelRoutingCard provider UX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMutation(mocks.providerMutation);
    resetMutation(mocks.urlMutation);
    resetMutation(mocks.modelMutation);
    mocks.pregenMutation.mutate.mockReset();
    mocks.pregenMutation.isPending = false;
    mocks.useAiHealth.mockReturnValue(health("ollama"));
    mocks.useSettings.mockReturnValue(settings("ollama"));
    mocks.useObservability.mockReturnValue(observability("ollama"));
    mocks.usePregenerate.mockReturnValue(mocks.pregenMutation);
    mocks.useSaveSettings.mockImplementation(() => {
      const call = mocks.saveCall++;
      if (call === 0) return mocks.providerMutation;
      if (call === 1) return mocks.urlMutation;
      return mocks.modelMutation;
    });
  });

  it("uses the pending provider for LMStudio URL visibility and provider copy", () => {
    mocks.providerMutation.isPending = true;
    mocks.providerMutation.variables = { local_provider: "lmstudio" };

    renderCard();

    expect(screen.getByLabelText("LMStudio server URL")).toHaveValue(
      "http://localhost:1234/v1",
    );
    expect(
      screen.getByText(/Realtime AI runs locally via LMStudio/i),
    ).toBeInTheDocument();
  });

  it("shows the client-side warning for non-loopback LMStudio URLs", () => {
    mocks.useAiHealth.mockReturnValue(health("lmstudio", { ok: false }));
    mocks.useSettings.mockReturnValue(
      settings("lmstudio", {
        lmstudio_url: "http://192.168.1.10:1234/v1",
      }),
    );
    mocks.useObservability.mockReturnValue(observability("lmstudio"));

    renderCard();

    expect(screen.getByText(/Non-loopback URL/i)).toBeInTheDocument();
    expect(isLoopbackLmsUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackLmsUrl("http://192.168.1.10:1234/v1")).toBe(false);
  });

  it("resyncs a role-picker draft when backend health arrives after mount", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ModelRolePicker
        label="Explain model"
        value=""
        models={[]}
        missing={false}
        pending={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByLabelText("Explain model")).toHaveValue("");

    rerender(
      <ModelRolePicker
        label="Explain model"
        value="qwen3:8b"
        models={[]}
        missing={false}
        pending={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByLabelText("Explain model")).toHaveValue("qwen3:8b");
  });
});
