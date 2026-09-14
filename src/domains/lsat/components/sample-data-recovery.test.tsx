import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("communicates and prevents duplicate retries while the probe is pending", async () => {
    let resolveRetry: (() => void) | undefined;
    const retry = vi.fn(() => new Promise<void>((resolve) => { resolveRetry = resolve; }));
    render(<SampleDataRecovery section="Practice" onRetry={retry} />);

    const status = screen.getByRole("status", { name: "Practice: sample data excluded" });
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);

    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Retrying…");
    expect(status).toHaveAttribute("aria-busy", "true");

    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();

    resolveRetry?.();
    await waitFor(() => expect(button).toHaveTextContent("Retry"));
    expect(button).not.toBeDisabled();
    expect(status).toHaveAttribute("aria-busy", "false");
  });
});
