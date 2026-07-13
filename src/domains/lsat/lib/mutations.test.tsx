import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";

// 7.2 — mutation cache-invalidation contract. We render each hook against a real
// QueryClient (spying on invalidateQueries) with the API + toast mocked, then
// drive the mutation and assert exactly which query keys get invalidated. Also
// covers the offline fallback wiring (useAddErrorLog enqueues on failure).

// vi.mock is hoisted above the file, so the spies it references must be created
// via vi.hoisted (also hoisted) rather than plain top-level consts.
const { apiMock, enqueueMock } = vi.hoisted(() => ({
  apiMock: {
    createDrill: vi.fn(),
    saveSettings: vi.fn(),
    createPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    addErrorLog: vi.fn(),
  },
  enqueueMock: vi.fn(),
}));

vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return { ...actual, api: apiMock };
});

vi.mock("./toast", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("./offlineQueue", () => ({
  enqueue: (...a: unknown[]) => enqueueMock(...a),
  removeQueuedErrorLog: vi.fn(),
}));

import {
  useAddErrorLog,
  useCreateDrill,
  useCreatePlaylist,
  useDeletePlaylist,
  useSaveSettings,
  useUpdatePlaylist,
} from "./mutations";
import type { AiHealth, PlaylistSummary, Settings } from "./types";

/** Seed the `playlists` query with the `withFallback` envelope the hooks edit. */
function seedPlaylists(client: QueryClient, list: PlaylistSummary[]) {
  client.setQueryData(["playlists"], { data: list, usingSample: false });
}

function readPlaylists(client: QueryClient): PlaylistSummary[] {
  return (
    client.getQueryData<{ data: PlaylistSummary[] }>(["playlists"])?.data ?? []
  );
}

function pl(id: number, name: string): PlaylistSummary {
  return { id, name, kind: "smart", count: 0 };
}

function seedProviderCaches(client: QueryClient, provider: "ollama" | "lmstudio") {
  const settings: Settings = {
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
    },
    provider: {
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
    },
  };
  const aiHealth: AiHealth = {
    ollama: provider === "ollama",
    ok: true,
    provider,
    local_provider: provider,
    lmstudio_url: "http://localhost:1234/v1",
    models: ["qwen3:8b", "qwen3:14b"],
    explain_model: "qwen3:8b",
    gen_model: "qwen3:14b",
  };
  client.setQueryData(["settings"], { data: settings, usingSample: false });
  client.setQueryData(["ai-health"], { data: aiHealth, usingSample: false });
}

function readSettingsProvider(client: QueryClient): string | undefined {
  return client.getQueryData<{ data: Settings }>(["settings"])?.data.settings
    .local_provider;
}

function readHealthProvider(client: QueryClient): string | undefined {
  return client.getQueryData<{ data: AiHealth }>(["ai-health"])?.data.provider;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe("mutations — invalidation contract (7.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("useCreateDrill invalidates sessions + dashboard on success", async () => {
    apiMock.createDrill.mockResolvedValue({ session_id: 1 });
    const client = makeClient();
    const spy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useCreateDrill(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ q_type: "Flaw", count: 5 } as never);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["sessions"]);
    expect(keys).toContainEqual(["dashboard"]);
  });

  it("useSaveSettings invalidates settings, observability and ai-health", async () => {
    apiMock.saveSettings.mockResolvedValue({});
    const client = makeClient();
    const spy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useSaveSettings(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ explain_model: "qwen3:8b" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["settings"]);
    expect(keys).toContainEqual(["observability"]);
    expect(keys).toContainEqual(["ai-health"]);
  });

  it("useUpdatePlaylist invalidates the list and the parametrized detail key", async () => {
    apiMock.updatePlaylist.mockResolvedValue({ id: 42, name: "x" });
    const client = makeClient();
    const spy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdatePlaylist(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ id: 42, name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["playlists"]);
    expect(keys).toContainEqual(["playlist", 42]);
  });

  it("useAddErrorLog enqueues an offline write when the API call fails", async () => {
    apiMock.addErrorLog.mockRejectedValue(new Error("offline"));
    const client = makeClient();

    const { result } = renderHook(() => useAddErrorLog(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ attemptId: 7, reason: "concept", note: "n" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(enqueueMock).toHaveBeenCalledWith({
      kind: "addErrorLog",
      attemptId: 7,
      body: { reason: "concept", note: "n" },
    });
  });
});

// R10 A4.2 — optimistic-update contract. Each high-frequency playlist mutation
// edits the `playlists` cache synchronously (instant UI) and must restore the
// pre-mutation snapshot when the request fails (clean rollback).
describe("mutations — optimistic updates + rollback (R10 A4.2)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("useDeletePlaylist removes the row instantly, then rolls back on error", async () => {
    // Never-resolving so we can observe the optimistic state before settling.
    let reject: (e: unknown) => void = () => {};
    apiMock.deletePlaylist.mockReturnValue(
      new Promise((_res, rej) => (reject = rej)),
    );
    const client = makeClient();
    seedPlaylists(client, [pl(1, "Keep"), pl(2, "Drop")]);

    const { result } = renderHook(() => useDeletePlaylist(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate(2);

    // Optimistic: row 2 is gone immediately, before the request settles.
    await waitFor(() =>
      expect(readPlaylists(client).map((p) => p.id)).toEqual([1]),
    );

    // The request fails -> the original list is restored.
    reject(new Error("boom"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readPlaylists(client).map((p) => p.id)).toEqual([1, 2]);
  });

  it("useCreatePlaylist inserts an optimistic row, then rolls back on error", async () => {
    let reject: (e: unknown) => void = () => {};
    apiMock.createPlaylist.mockReturnValue(
      new Promise((_res, rej) => (reject = rej)),
    );
    const client = makeClient();
    seedPlaylists(client, [pl(1, "Existing")]);

    const { result } = renderHook(() => useCreatePlaylist(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ name: "Brand new" });

    // Optimistic: a row with the new name appears at the head of the list.
    await waitFor(() => expect(readPlaylists(client)).toHaveLength(2));
    expect(readPlaylists(client)[0].name).toBe("Brand new");

    // The request fails -> back to just the original row.
    reject(new Error("boom"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readPlaylists(client).map((p) => p.name)).toEqual(["Existing"]);
  });

  it("useUpdatePlaylist overlays the patch instantly, then rolls back on error", async () => {
    let reject: (e: unknown) => void = () => {};
    apiMock.updatePlaylist.mockReturnValue(
      new Promise((_res, rej) => (reject = rej)),
    );
    const client = makeClient();
    seedPlaylists(client, [pl(1, "Old name"), pl(2, "Other")]);

    const { result } = renderHook(() => useUpdatePlaylist(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ id: 1, name: "New name" });

    // Optimistic: row 1 shows the new name; row 2 untouched.
    await waitFor(() =>
      expect(readPlaylists(client).find((p) => p.id === 1)?.name).toBe(
        "New name",
      ),
    );
    expect(readPlaylists(client).find((p) => p.id === 2)?.name).toBe("Other");

    // The request fails -> the original name is restored.
    reject(new Error("boom"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readPlaylists(client).find((p) => p.id === 1)?.name).toBe(
      "Old name",
    );
  });

  it("useSaveSettings flips local provider optimistically, then rolls back on error", async () => {
    let reject: (e: unknown) => void = () => {};
    apiMock.saveSettings.mockReturnValue(
      new Promise((_res, rej) => (reject = rej)),
    );
    const client = makeClient();
    seedProviderCaches(client, "ollama");

    const { result } = renderHook(() => useSaveSettings(), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ local_provider: "lmstudio" });

    await waitFor(() => {
      expect(readSettingsProvider(client)).toBe("lmstudio");
      expect(readHealthProvider(client)).toBe("lmstudio");
    });

    reject(new Error("provider save failed"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readSettingsProvider(client)).toBe("ollama");
    expect(readHealthProvider(client)).toBe("ollama");
  });
});
