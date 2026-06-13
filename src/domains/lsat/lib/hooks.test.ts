import { beforeEach, describe, expect, it, vi } from "vitest";
import { unwrap, withFallback } from "./hooks";
import { ApiError } from "./api";
import { ApiValidationError } from "./apiSchemas";
import { getOfflineSnapshot, setOfflineMode } from "./offline";

// `unwrap` is a pure accessor over a query-result-shaped object. We can test it
// without React or a QueryClient by passing a plain object with the fields it
// reads (7.6 — collapsing the `query.data?.data` double-unwrap).

function fakeQuery<T>(over: {
  data?: { data: T; usingSample: boolean };
  isLoading?: boolean;
  isError?: boolean;
  isPlaceholderData?: boolean;
  error?: Error | null;
  refetch?: () => unknown;
}) {
  return {
    data: over.data,
    isLoading: over.isLoading ?? false,
    isError: over.isError ?? false,
    isPlaceholderData: over.isPlaceholderData ?? false,
    error: over.error ?? null,
    refetch: over.refetch ?? (() => undefined),
  };
}

describe("unwrap — flatten the withFallback envelope (7.6)", () => {
  it("flattens `{data,usingSample}` so `data` is the payload directly", () => {
    const q = fakeQuery({ data: { data: [1, 2, 3], usingSample: false } });
    const u = unwrap<number[]>(q);
    expect(u.data).toEqual([1, 2, 3]);
    expect(u.usingSample).toBe(false);
  });

  it("hoists usingSample for the offline/sample case", () => {
    const q = fakeQuery({ data: { data: { ok: true }, usingSample: true } });
    expect(unwrap(q).usingSample).toBe(true);
  });

  it("returns data=undefined and usingSample=false before the first resolve", () => {
    const q = fakeQuery<number[]>({ data: undefined, isLoading: true });
    const u = unwrap<number[]>(q);
    expect(u.data).toBeUndefined();
    expect(u.usingSample).toBe(false);
    expect(u.isLoading).toBe(true);
  });

  it("passes status flags through unchanged", () => {
    const err = new Error("boom");
    const u = unwrap(
      fakeQuery({ isError: true, error: err, isPlaceholderData: true }),
    );
    expect(u.isError).toBe(true);
    expect(u.error).toBe(err);
    expect(u.isPlaceholderData).toBe(true);
  });

  it("exposes a refetch that invokes the underlying query.refetch", () => {
    const refetch = vi.fn(() => Promise.resolve());
    unwrap(fakeQuery({ refetch })).refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not throw when isPlaceholderData is absent (older shape)", () => {
    const q = {
      data: { data: 1, usingSample: false },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => undefined,
    };
    expect(unwrap<number>(q).isPlaceholderData).toBe(false);
  });
});

describe("withFallback — sample/offline envelope (7.2)", () => {
  beforeEach(() => {
    // Reset the shared offline flag between cases.
    setOfflineMode(false);
  });

  it("wraps a successful fetch as {data, usingSample:false} and clears offline", async () => {
    setOfflineMode(true); // pretend we were offline
    const wrapped = withFallback(() => Promise.resolve({ score: 164 }), {
      score: 0,
    });
    const out = await wrapped();
    expect(out).toEqual({ data: { score: 164 }, usingSample: false });
    expect(getOfflineSnapshot()).toBe(false);
  });

  it("falls back to the sample on a genuine connectivity failure (fetch TypeError) and flags offline", async () => {
    const fallback = { score: -1 };
    // A native fetch network failure rejects with a TypeError ("Failed to fetch").
    const wrapped = withFallback(
      () => Promise.reject(new TypeError("Failed to fetch")),
      fallback,
    );
    const out = await wrapped();
    expect(out.usingSample).toBe(true);
    expect(out.data).toBe(fallback); // exact fallback reference returned
    expect(getOfflineSnapshot()).toBe(true);
  });

  it("falls back + flags offline on an aborted/timed-out request", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const wrapped = withFallback(() => Promise.reject(abort), "fb");
    const out = await wrapped();
    expect(out.usingSample).toBe(true);
    expect(getOfflineSnapshot()).toBe(true);
  });

  it("calls the fetcher each time the wrapped fn is invoked", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const wrapped = withFallback(fetcher, 0);
    await wrapped();
    await wrapped();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // Fix #3 — a reachable backend that returns an error (HTTP 4xx/5xx) must NOT
  // masquerade as offline: the error propagates into the query's error state.
  it("re-throws an ApiError (reachable backend) instead of falling back, and clears offline", async () => {
    setOfflineMode(true);
    const err = new ApiError("Server error", 500);
    const wrapped = withFallback(() => Promise.reject(err), "fallback");
    await expect(wrapped()).rejects.toBe(err);
    expect(getOfflineSnapshot()).toBe(false);
  });

  // Fix #3 — a contract drift (zod parse failure) must surface so the
  // ErrorBoundary catches it, not be hidden behind a sample fallback.
  it("re-throws an ApiValidationError instead of falling back", async () => {
    const err = new ApiValidationError("/api/x", []);
    const wrapped = withFallback(() => Promise.reject(err), "fallback");
    await expect(wrapped()).rejects.toBe(err);
    expect(getOfflineSnapshot()).toBe(false);
  });

  // A non-network, non-API Error (e.g. a logic bug in the fetcher) is not an
  // offline signal either — surface it rather than disguising it as sample data.
  it("re-throws an unknown/plain Error rather than swallowing it", async () => {
    const wrapped = withFallback(() => {
      throw new Error("logic bug");
    }, "fallback");
    await expect(wrapped()).rejects.toThrow("logic bug");
  });
});
