import { describe, it, expect } from "vitest";
import { formatClock, formatMs, pct, timeAgo } from "./utils";

describe("formatClock", () => {
  it("formats seconds as mm:ss with padding", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(90)).toBe("01:30");
    expect(formatClock(3599)).toBe("59:59");
  });
  it("clamps negatives to zero", () => {
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("formatMs", () => {
  it("formats milliseconds as m:ss", () => {
    expect(formatMs(1000)).toBe("0:01");
    expect(formatMs(90000)).toBe("1:30");
  });
});

describe("pct", () => {
  it("rounds a 0..1 fraction to a percent string", () => {
    expect(pct(0.5)).toBe("50%");
    expect(pct(0.666)).toBe("67%");
    expect(pct(0)).toBe("0%");
  });
});

describe("timeAgo", () => {
  it("returns 'just now' under a minute", () => {
    expect(timeAgo(new Date(Date.now() - 30_000).toISOString())).toBe("just now");
  });
  it("returns minutes / hours / days", () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
  it("returns '' for an invalid date", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });
});
