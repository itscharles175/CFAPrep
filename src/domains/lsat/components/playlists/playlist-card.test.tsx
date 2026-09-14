import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaylistCard } from "./playlist-card";
import type { PlaylistSummary } from "@lsat/lib/types";

const playlist = (overrides: Partial<PlaylistSummary> = {}): PlaylistSummary => ({
  id: 7,
  name: "Review weak spots",
  kind: "smart",
  count: 12,
  criteria: { section_type: "LR", q_type: "Flaw", difficulty: 4 },
  ...overrides,
});

describe("PlaylistCard selection surface", () => {
  it("keeps collection metadata and the play action readable together", () => {
    render(
      <PlaylistCard
        playlist={playlist()}
        playing={false}
        onPlay={vi.fn()}
        onEditCriteria={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("Review weak spots")).toBeInTheDocument();
    expect(screen.getByText("12 questions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Play$/i })).toBeEnabled();
    expect(document.querySelector(".lsat-playlist-card")).toBeInTheDocument();
  });

  it("disables play for an empty manual collection while preserving actions", () => {
    render(
      <PlaylistCard
        playlist={playlist({ kind: "manual", count: 0, criteria: null })}
        playing={false}
        onPlay={vi.fn()}
        onEditCriteria={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("Empty — add questions from the bank or review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Play$/i })).toBeDisabled();
  });
});
