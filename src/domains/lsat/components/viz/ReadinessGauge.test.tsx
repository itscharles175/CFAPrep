import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadinessGauge } from "./ReadinessGauge";

describe("ReadinessGauge", () => {
  it("renders a titled arc per ring plus the center label", () => {
    const { container } = render(
      <ReadinessGauge
        rings={[
          { name: "Accuracy", value: 0.8, color: "hsl(0 0% 0%)" },
          { name: "Volume", value: 0.5, color: "hsl(0 0% 0%)" },
        ]}
        centerTop={<span>72</span>}
      />,
    );
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /readiness composite/i })).toBeInTheDocument();
    // One SVG <title> per ring, with the rounded percentage.
    const titles = Array.from(container.querySelectorAll("title")).map(
      (t) => t.textContent,
    );
    expect(titles).toEqual(["Accuracy: 80%", "Volume: 50%"]);
  });

  it("keeps the titles when the draw-on animation is enabled", () => {
    const { container } = render(
      <ReadinessGauge
        animate
        rings={[{ name: "Accuracy", value: 0.6, color: "hsl(0 0% 0%)" }]}
        centerTop={<span>60</span>}
      />,
    );
    const titles = Array.from(container.querySelectorAll("title")).map(
      (t) => t.textContent,
    );
    expect(titles).toEqual(["Accuracy: 60%"]);
  });
});
