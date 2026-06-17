import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NearDuplicatePanel } from "../near-duplicate-panel";

const CLUSTERS = [
  {
    content_hash: "hash-1",
    cluster_key: "text:abc123",
    duplicate_kind: "normalized_text",
    count: 3,
    question_ids: [17, 18, 19],
    recommended_canonical_id: 17,
    quarantine_candidate_ids: [18, 19],
    source_mix: { official: 2, research: 1 },
    q_type_mix: { Flaw: 3 },
    sample: "Researchers sampled only one neighborhood before generalizing citywide.",
  },
];

describe("NearDuplicatePanel", () => {
  it("renders clusters with the sample and merge affordance", () => {
    render(<NearDuplicatePanel clusters={CLUSTERS} onMerge={vi.fn()} />);

    expect(screen.getByText("Near-duplicate clusters")).toBeInTheDocument();
    expect(screen.getByText("text:abc123")).toBeInTheDocument();
    expect(screen.getByText("3 rows")).toBeInTheDocument();
    expect(screen.getByText("normalized text")).toBeInTheDocument();
    expect(screen.getByText("Questions #17, #18, #19")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Researchers sampled only one neighborhood before generalizing citywide.",
      ),
    ).toBeInTheDocument();
  });

  it("merges with the canonical id and full expected id set", async () => {
    const onMerge = vi.fn();
    render(<NearDuplicatePanel clusters={CLUSTERS} onMerge={onMerge} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: /Merge cluster text:abc123: keep #17, quarantine 2/i,
      }),
    );

    expect(onMerge).toHaveBeenCalledWith("text:abc123", 17, [17, 18, 19]);
  });

  it("shows an empty state and no merge button when there are no clusters", () => {
    render(<NearDuplicatePanel clusters={[]} onMerge={vi.fn()} />);

    expect(
      screen.getByText("No near-duplicate clusters detected."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides the merge button when no handler is provided (read-only)", () => {
    render(<NearDuplicatePanel clusters={CLUSTERS} />);

    expect(screen.getByText("text:abc123")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
