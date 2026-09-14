import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalSettingsForm } from "./goal-settings-form";

const mocks = vi.hoisted(() => ({
  persistGoal: vi.fn(),
  savePlan: { mutate: vi.fn() },
  useSaveStudyPlan: vi.fn(),
}));

vi.mock("@lsat/lib/prefs", () => ({
  getGoal: () => ({ targetScore: 165, examDate: "" }),
  getPlanBudgetMin: () => 60,
  setGoal: mocks.persistGoal,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useSaveStudyPlan: mocks.useSaveStudyPlan,
}));

describe("GoalSettingsForm exam date", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSaveStudyPlan.mockReturnValue(mocks.savePlan);
  });

  it("uses one keyboard-stop date field with an explicit format hint", () => {
    render(<GoalSettingsForm />);

    const date = screen.getByRole("textbox", { name: "Exam date" });
    expect(date).toHaveAttribute("type", "text");
    expect(date).toHaveAttribute("inputmode", "numeric");
    expect(date).toHaveAttribute("placeholder", "YYYY-MM-DD");
    expect(date).toHaveAttribute("aria-describedby", "exam-date-hint");
    expect(screen.getByText(/Enter the date as YYYY-MM-DD/i)).toBeInTheDocument();
  });

  it("prevents invalid calendar dates from being saved", async () => {
    const user = userEvent.setup();
    render(<GoalSettingsForm />);

    const date = screen.getByRole("textbox", { name: "Exam date" });
    await user.type(date, "2026-02-31");
    await user.click(screen.getByRole("button", { name: "Save goal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the exam date as YYYY-MM-DD.");
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(mocks.persistGoal).not.toHaveBeenCalled();
    expect(mocks.savePlan.mutate).not.toHaveBeenCalled();
  });

  it("saves a valid ISO date through the existing local and server pipelines", async () => {
    const user = userEvent.setup();
    render(<GoalSettingsForm />);

    const date = screen.getByRole("textbox", { name: "Exam date" });
    await user.type(date, "2026-11-14");
    await user.click(screen.getByRole("button", { name: "Save goal" }));

    expect(mocks.persistGoal).toHaveBeenCalledWith({
      targetScore: 165,
      examDate: "2026-11-14",
      bandLow: 163,
      bandHigh: 167,
    });
    expect(mocks.savePlan.mutate).toHaveBeenCalledWith({
      target_score: 165,
      exam_date: "2026-11-14",
      daily_minutes: 60,
    });
  });
});
