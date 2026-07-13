import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ChoiceList } from "./choice-list";
import type { Choice } from "@lsat/lib/types";

// Choices carry the correctness flags the review form would include — the timed
// list must IGNORE them entirely while `reveal` is false.
const CHOICES: Choice[] = [
  { id: 1, label: "A", text: "First choice", is_correct: false, trap_type: "reversal" },
  { id: 2, label: "B", text: "Second choice", is_correct: true, trap_type: "none" },
  { id: 3, label: "C", text: "Third choice", is_correct: false, trap_type: "degree" },
];

describe("ChoiceList — Test-Mode integrity (R9 commit micro-moment)", () => {
  it("uses shared roving radio behavior while keeping eliminate controls reachable", () => {
    render(
      <ChoiceList
        choices={CHOICES}
        selected={null}
        eliminated={new Set()}
        onSelect={() => {}}
        onToggleEliminate={() => {}}
        reveal={false}
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "-1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Eliminate choice A" })).toBeInTheDocument();

    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(radios[1]).toHaveFocus();
  });

  it("selects by radio keyboard without leaking the event to exam-level shortcuts", () => {
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <ChoiceList
          choices={CHOICES}
          selected={selected}
          eliminated={new Set()}
          onSelect={setSelected}
          onToggleEliminate={() => {}}
          reveal={false}
        />
      );
    }
    const onWindowKeydown = vi.fn();
    window.addEventListener("keydown", onWindowKeydown);
    render(<Harness />);
    const radios = screen.getAllByRole("radio");

    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "c" });

    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(onWindowKeydown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKeydown);
  });

  it("lets modified keys bubble so Shift+E elimination still belongs to the runner", () => {
    const onWindowKeydown = vi.fn();
    window.addEventListener("keydown", onWindowKeydown);
    render(
      <ChoiceList
        choices={CHOICES}
        selected="B"
        eliminated={new Set()}
        onSelect={() => {}}
        onToggleEliminate={() => {}}
        reveal={false}
      />,
    );
    fireEvent.keyDown(screen.getByRole("radio", { name: /Second choice/ }), {
      key: "E",
      shiftKey: true,
    });

    expect(onWindowKeydown).toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKeydown);
  });

  it("reveals NO correctness while timed, even with is_correct/trap data present", () => {
    const { container } = render(
      <ChoiceList
        choices={CHOICES}
        selected="A"
        eliminated={new Set()}
        onSelect={() => {}}
        onToggleEliminate={() => {}}
        reveal={false}
      />,
    );
    // No success / destructive classes anywhere — the neutral commit settle uses
    // only the `primary` accent, never a correct/wrong cue.
    expect(container.querySelector(".border-success, .bg-success, .text-success")).toBeNull();
    expect(
      container.querySelector(".border-destructive, .bg-destructive, .text-destructive"),
    ).toBeNull();
    // No trap labels leak in timed mode.
    expect(screen.queryByText(/trap:/i)).toBeNull();
    // The committed choice DOES get the neutral primary ink-set.
    expect(container.querySelector(".bg-primary")).not.toBeNull();
  });

  it("commits a selection without exposing whether it is right", () => {
    const onSelect = vi.fn();
    render(
      <ChoiceList
        choices={CHOICES}
        selected={null}
        eliminated={new Set()}
        onSelect={onSelect}
        onToggleEliminate={() => {}}
        reveal={false}
      />,
    );
    // B is the correct answer, but selecting it must look identical to any pick.
    fireEvent.click(screen.getByRole("radio", { name: /Second choice/ }));
    expect(onSelect).toHaveBeenCalledWith("B");
    // The radio reflects selection state, not correctness.
    const radioB = screen.getByRole("radio", { name: /Second choice/ });
    expect(radioB.getAttribute("aria-checked")).toBe("false"); // parent owns `selected`
  });

  it("only shows correctness once reveal is true", () => {
    const { container } = render(
      <ChoiceList
        choices={CHOICES}
        selected="A"
        eliminated={new Set()}
        onSelect={() => {}}
        onToggleEliminate={() => {}}
        reveal
        correctAnswer="B"
      />,
    );
    // In review the correct answer is finally styled, and the wrong pick too.
    expect(container.querySelector(".bg-success, .border-success, .text-success")).not.toBeNull();
    expect(
      container.querySelector(".bg-destructive, .border-destructive, .text-destructive"),
    ).not.toBeNull();
  });
});
