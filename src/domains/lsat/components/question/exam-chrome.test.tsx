import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResizableSplit } from "./exam-chrome";

describe("ResizableSplit responsive contract", () => {
  it("marks the panes for the stacked narrow layout while preserving the desktop fraction", () => {
    render(
      <ResizableSplit
        fraction={0.42}
        onChange={vi.fn()}
        left={<p>Passage</p>}
        right={<p>Question</p>}
      />,
    );

    const split = document.querySelector(".lsat-resizable-split");
    const left = document.querySelector(".lsat-split-pane-left");
    const divider = screen.getByRole("separator", { name: "Resize passage and question panes" });

    expect(split).toHaveClass("lsat-resizable-split");
    expect(left).toHaveClass("lsat-split-pane");
    expect(left).toHaveStyle({ "--split-basis": "42%" });
    expect(divider).toHaveClass("lsat-split-divider");
  });
});
