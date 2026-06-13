import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TimerSettingsForm } from "@/components/settings/timer-settings-form";
import { AnalyticsFilters } from "@/components/analytics/AnalyticsFilters";

// Bundle F2 — form controls must be programmatically associated with their
// labels (id + htmlFor, or aria-labelledby for non-labelable Radix groups).
// These tests fail if a label is rendered without being tied to its control,
// since getByLabelText / accessible-name lookups only resolve when the
// association exists.

describe("TimerSettingsForm label associations", () => {
  it("ties the LR and RC minute inputs to their labels", () => {
    render(<TimerSettingsForm />);

    const lr = screen.getByLabelText("LR section (minutes)");
    const rc = screen.getByLabelText("RC section (minutes)");

    expect(lr).toHaveAttribute("type", "number");
    expect(rc).toHaveAttribute("type", "number");
    // Distinct controls, each with its own accessible name.
    expect(lr).not.toBe(rc);
    expect(lr).toHaveAccessibleName("LR section (minutes)");
    expect(rc).toHaveAccessibleName("RC section (minutes)");
  });
});

describe("AnalyticsFilters label associations", () => {
  it("links the source and range labels to their Select triggers", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsFilters
        source="official"
        range="7"
        comparePrior={false}
        onSourceChange={() => {}}
        onRangeChange={() => {}}
        onCompareChange={() => {}}
      />,
    );

    // Controls live inside a Sheet (Radix Dialog) that must be opened first.
    await user.click(screen.getByRole("button", { name: /filters/i }));
    const dialog = await screen.findByRole("dialog");

    // Assert the DOM-level association (label.htmlFor -> control.id) directly,
    // which is what the fix wires and is independent of Radix ARIA internals.
    for (const text of ["Question source", "Time range"]) {
      const label = within(dialog).getByText(text);
      const forId = label.getAttribute("for");
      expect(forId).toBeTruthy();
      const control = document.getElementById(forId as string);
      expect(control).not.toBeNull();
      // Radix Select trigger renders a combobox button.
      expect(control).toHaveAttribute("role", "combobox");
    }
  });
});
