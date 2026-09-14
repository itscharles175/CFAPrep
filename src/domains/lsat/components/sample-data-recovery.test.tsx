import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SampleDataRecovery } from "./sample-data-recovery";

describe("SampleDataRecovery", () => {
  it("labels sample values as excluded instead of presenting them as progress", () => {
    const retry = vi.fn();
    render(<SampleDataRecovery section="Analytics" onRetry={retry} />);

    expect(screen.getByRole("status", { name: "Analytics: sample data excluded" })).toBeInTheDocument();
    expect(screen.getByText("Sample data excluded")).toBeInTheDocument();
    expect(screen.getByText(/will not use built-in sample values as your progress/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
