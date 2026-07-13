import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationInlineEditor,
  getAnnotationTags,
  getUserExplanation,
} from "./annotation-inline-editor";

// The backend sync is best-effort; stub it so the editor's local-first behavior
// is tested without a live backend. Both stubs resolve true (synced).
const syncMocks = vi.hoisted(() => ({
  syncExplanation: vi.fn().mockResolvedValue(true),
  syncTags: vi.fn().mockResolvedValue(true),
}));

vi.mock("@lsat/lib/annotationSync", () => ({
  syncExplanation: (...args: unknown[]) => syncMocks.syncExplanation(...args),
  syncTags: (...args: unknown[]) => syncMocks.syncTags(...args),
}));

describe("AnnotationInlineEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    syncMocks.syncExplanation.mockClear();
    syncMocks.syncTags.mockClear();
  });

  it("persists the explanation + tags to localStorage on save", async () => {
    const user = userEvent.setup();
    render(<AnnotationInlineEditor questionId={42} />);

    await user.type(
      screen.getByLabelText("Your explanation for this question"),
      "Classic causal reversal.",
    );
    await user.type(screen.getByLabelText("Add a tag"), "causal-reversal");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await user.click(screen.getByRole("button", { name: /save note/i }));

    await waitFor(() => {
      expect(getUserExplanation(42)).toBe("Classic causal reversal.");
    });
    expect(getAnnotationTags(42)).toEqual(["causal-reversal"]);
    // No annotationId supplied -> no backend sync attempted.
    expect(syncMocks.syncExplanation).not.toHaveBeenCalled();
  });

  it("hydrates from previously-saved values", () => {
    localStorage.setItem("lsatlab.userExplanation.7", "Prior note text");
    localStorage.setItem("lsatlab.annotationTags.7", JSON.stringify(["trap"]));

    render(<AnnotationInlineEditor questionId={7} />);

    expect(
      screen.getByLabelText("Your explanation for this question"),
    ).toHaveValue("Prior note text");
    expect(screen.getByText("trap")).toBeInTheDocument();
  });

  it("best-effort syncs to the backend when an annotationId is given", async () => {
    const user = userEvent.setup();
    render(<AnnotationInlineEditor questionId={9} annotationId={123} />);

    await user.type(
      screen.getByLabelText("Your explanation for this question"),
      "Synced note.",
    );
    await user.click(screen.getByRole("button", { name: /save note/i }));

    await waitFor(() => {
      expect(syncMocks.syncExplanation).toHaveBeenCalledWith(123, "Synced note.");
    });
    // Local copy is written regardless of sync outcome.
    expect(getUserExplanation(9)).toBe("Synced note.");
  });

  it("removes a tag before saving", async () => {
    const user = userEvent.setup();
    render(<AnnotationInlineEditor questionId={3} />);

    await user.type(screen.getByLabelText("Add a tag"), "tempTag");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("tempTag")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove tag tempTag" }));
    expect(screen.queryByText("tempTag")).not.toBeInTheDocument();
  });
});
