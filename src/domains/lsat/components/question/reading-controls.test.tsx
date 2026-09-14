import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_READING } from "@lsat/lib/prefs";
import { ReadingControls } from "./reading-controls";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

function renderControls() {
  return render(
    <>
      <ReadingControls prefs={DEFAULT_READING} onChange={vi.fn()} />
      <button type="button">Outside</button>
    </>,
  );
}

describe("ReadingControls", () => {
  it("exposes a named disclosure and a keyboard-focusable scroll region", async () => {
    const user = userEvent.setup();
    renderControls();

    const trigger = screen.getByRole("button", { name: "Reading display options" });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    const panel = screen.getByRole("region", { name: "Reading display options" });
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(panel.querySelector('[tabindex="0"]')).not.toBeNull();
    expect(screen.getByRole("slider", { name: "Reading line width" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Serif reading font" })).toBeInTheDocument();
  });

  it("restores trigger focus on Escape from an inner control", async () => {
    const user = userEvent.setup();
    renderControls();

    const trigger = screen.getByRole("button", { name: "Reading display options" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Increase text size" }));

    await user.keyboard("{Escape}");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Reading display options" })).toBeNull();
  });

  it("closes from an outside click while preserving outside focus", async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole("button", { name: "Reading display options" }));
    const outside = screen.getByRole("button", { name: "Outside" });
    await user.click(outside);

    expect(outside).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Reading display options" })).toBeNull();
  });
});
