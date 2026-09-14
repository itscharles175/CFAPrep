import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalLoadingBar } from "./global-loading-bar";

function setMotionPreference(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
}

function renderBar() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <GlobalLoadingBar>
        <div>Route content</div>
      </GlobalLoadingBar>
    </MemoryRouter>,
  );
}

describe("GlobalLoadingBar", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the acknowledgement bar hidden when reduced motion is requested", () => {
    setMotionPreference(true);
    renderBar();

    expect(screen.queryByRole("progressbar", { hidden: true })).not.toBeInTheDocument();
  });

  it("shows a brief acknowledgement for a cached route by default", () => {
    vi.useFakeTimers();
    setMotionPreference(false);
    renderBar();

    const bar = screen.getByRole("progressbar", { hidden: true });
    expect(bar).toHaveClass("lsat-global-loading-bar");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("progressbar", { hidden: true })).not.toBeInTheDocument();
  });
});
