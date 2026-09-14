import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SystemNotice } from "./system-notice";

describe("SystemNotice", () => {
  it("keeps the dismiss control visually compact while providing a 40px hit area", () => {
    const onDismiss = vi.fn();

    render(
      <SystemNotice onDismiss={onDismiss} title="Connection paused">
        Retry when the local service is available.
      </SystemNotice>,
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss).toHaveClass("h-10", "w-10", "items-center", "justify-center");
    expect(dismiss.querySelector("svg")).toHaveClass("h-4", "w-4");

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
