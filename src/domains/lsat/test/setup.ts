import "@testing-library/jest-dom/vitest";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// localStorage stub — isolate tests from real browser storage.
// ---------------------------------------------------------------------------
const _storage: Record<string, string> = {};
const localStorageMock: Storage = {
  getItem: (k) => _storage[k] ?? null,
  setItem: (k, v) => { _storage[k] = String(v); },
  removeItem: (k) => { delete _storage[k]; },
  clear: () => { Object.keys(_storage).forEach((k) => delete _storage[k]); },
  key: (i) => Object.keys(_storage)[i] ?? null,
  get length() { return Object.keys(_storage).length; },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Clear between tests so state doesn't bleed.
beforeEach(() => localStorageMock.clear());

// ---------------------------------------------------------------------------
// QueryClient factory — export so individual test files can create their own
// isolated client without the default retry/stale settings interfering.
// ---------------------------------------------------------------------------
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

// ---------------------------------------------------------------------------
// isTauri stub — always return false in tests so Tauri-gated paths are skipped.
// ---------------------------------------------------------------------------
vi.mock("@lsat/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@lsat/lib/tauri")>("@lsat/lib/tauri");
  return { ...actual, isTauri: () => false };
});

// ---------------------------------------------------------------------------
// fetch mock — point at nowhere so accidental real requests fail fast.
// ---------------------------------------------------------------------------
globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch is not available in tests"));
