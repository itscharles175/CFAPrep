import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopTrapExplainer } from "./top-trap-explainer";

const hookMocks = vi.hoisted(() => ({
  useTraps: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useTraps: () => hookMocks.useTraps(),
}));

describe("TopTrapExplainer", () => {
  beforeEach(() => {
    hookMocks.useTraps.mockReset();
  });

  it("shows an accessible loading state while trap data loads", () => {
    hookMocks.useTraps.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(
      <MemoryRouter>
        <TopTrapExplainer />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading trap explainer",
    );
  });
});
