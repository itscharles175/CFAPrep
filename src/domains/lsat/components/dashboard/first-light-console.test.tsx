import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FirstLightConsole } from "./first-light-console";

const navigate = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

describe("FirstLightConsole", () => {
  it("prioritizes a first section while keeping goal setting available", () => {
    render(<FirstLightConsole />);

    expect(screen.getByText("Recommended next")).toBeInTheDocument();
    expect(screen.getByText(/available after your first section/i)).toBeInTheDocument();
    expect(screen.getByText("Recommended next")).toHaveClass("type-overline", "text-primary");
    expect(screen.getByRole("button", { name: "Set goal" })).toHaveClass("min-h-10");

    fireEvent.click(screen.getByRole("button", { name: "Start a section" }));
    fireEvent.click(screen.getByRole("button", { name: "Set goal" }));

    expect(navigate).toHaveBeenNthCalledWith(1, "/practice");
    expect(navigate).toHaveBeenNthCalledWith(2, "/settings");
  });
});
