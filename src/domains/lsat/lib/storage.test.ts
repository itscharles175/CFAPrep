import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_KEYS,
  getJSON,
  getRaw,
  getVersioned,
  remove,
  setJSON,
  setRaw,
  setVersioned,
} from "./storage";

describe("storage — centralized typed Web Storage (7.6)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe("getJSON / setJSON", () => {
    it("round-trips primitives, objects and arrays", () => {
      setJSON("k.num", 42);
      setJSON("k.obj", { a: 1, b: ["x", "y"] });
      setJSON("k.arr", [1, 2, 3]);
      expect(getJSON("k.num", 0)).toBe(42);
      expect(getJSON<{ a: number; b: string[] }>("k.obj", { a: 0, b: [] })).toEqual({
        a: 1,
        b: ["x", "y"],
      });
      expect(getJSON<number[]>("k.arr", [])).toEqual([1, 2, 3]);
    });

    it("returns the fallback for an absent key", () => {
      expect(getJSON("missing", "default")).toBe("default");
      expect(getJSON<number[]>("missing.arr", [])).toEqual([]);
    });

    it("returns the fallback (does not throw) for a corrupt value", () => {
      localStorage.setItem("k.bad", "{not valid json");
      expect(getJSON("k.bad", { ok: true })).toEqual({ ok: true });
    });

    it("persists across a simulated reload (re-reads from storage)", () => {
      setJSON("k.persist", { seen: 1 });
      // a fresh read (as after reload) reads the same backing store
      expect(getJSON("k.persist", null)).toEqual({ seen: 1 });
    });
  });

  describe("getRaw / setRaw / remove", () => {
    it("stores raw strings without JSON quoting", () => {
      setRaw("k.raw", "1");
      // a raw write is NOT JSON-encoded, so the backing value has no quotes
      expect(localStorage.getItem("k.raw")).toBe("1");
      expect(getRaw("k.raw")).toBe("1");
    });

    it("returns null for an absent raw key", () => {
      expect(getRaw("nope")).toBeNull();
    });

    it("remove() deletes a key", () => {
      setRaw("k.tmp", "v");
      expect(getRaw("k.tmp")).toBe("v");
      remove("k.tmp");
      expect(getRaw("k.tmp")).toBeNull();
    });
  });

  describe("sessionStorage area", () => {
    it("reads/writes the session area independently of local", () => {
      setRaw("k.s", "session-only", "session");
      expect(getRaw("k.s", "session")).toBe("session-only");
      // not present in localStorage
      expect(getRaw("k.s", "local")).toBeNull();
      expect(sessionStorage.getItem("k.s")).toBe("session-only");
    });
  });

  describe("versioned envelope", () => {
    it("round-trips when the version matches", () => {
      setVersioned("k.v", 2, { count: 5 });
      expect(getVersioned("k.v", 2, { count: 0 })).toEqual({ count: 5 });
    });

    it("returns the fallback when the version does NOT match (stale shape)", () => {
      setVersioned("k.v", 1, { count: 5 });
      // reading at a bumped version cleanly ignores the v1 payload
      expect(getVersioned("k.v", 2, { count: 0 })).toEqual({ count: 0 });
    });

    it("returns the fallback for an absent or corrupt versioned value", () => {
      expect(getVersioned("k.absent", 1, "fb")).toBe("fb");
      localStorage.setItem("k.corrupt", "{bad");
      expect(getVersioned("k.corrupt", 1, "fb")).toBe("fb");
    });

    it("wraps the payload as { v, data } on disk", () => {
      setVersioned("k.shape", 3, [1, 2]);
      expect(JSON.parse(localStorage.getItem("k.shape")!)).toEqual({
        v: 3,
        data: [1, 2],
      });
    });
  });

  describe("STORAGE_KEYS registry", () => {
    it("namespaces every fixed key under lsatlab.", () => {
      for (const key of Object.values(STORAGE_KEYS)) {
        expect(key.startsWith("lsatlab.")).toBe(true);
      }
    });

    it("pins the on-disk key strings that are part of the storage contract", () => {
      // Renaming any of these would silently reset existing users' data.
      expect(STORAGE_KEYS.goal).toBe("lsatlab.goal");
      expect(STORAGE_KEYS.offlineQueue).toBe("lsatlab.offlineQueue");
      expect(STORAGE_KEYS.keyboardMap).toBe("lsatlab.keyboardMap");
      expect(STORAGE_KEYS.density).toBe("lsatlab.density");
    });
  });
});
