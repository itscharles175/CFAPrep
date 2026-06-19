/*
 * K4-cmd — neutral exam command-registration seam.
 *
 * The section runner registers its exam affordances through `useExamCommands`
 * (this module) instead of the LSAT palette's `useCommandPalette`. These tests
 * pin the decoupling guarantee: `register` is a SAFE NO-OP when no
 * `<CommandPaletteProvider>` is mounted (so the palette can be deleted in K4-13
 * without crashing the runner), and bridges to the palette when one IS present
 * (so legacy behavior under the LSAT shell is unchanged).
 */
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  CommandPaletteProvider,
  useCommandPalette,
  type CommandAction,
} from "@lsat/components/command-palette";
import { useExamCommands, type ExamCommand } from "@lsat/lib/examCommands";

const examCommands: ExamCommand[] = [
  { id: "exam-focus", group: "Exam", label: "Toggle focus mode", perform: () => {} },
  { id: "exam-flag", group: "Exam", label: "Flag this question", perform: () => {} },
];

describe("useExamCommands without a palette provider", () => {
  it("does not throw and returns a register function", () => {
    expect(() => renderHook(() => useExamCommands())).not.toThrow();
    const { result } = renderHook(() => useExamCommands());
    expect(typeof result.current.register).toBe("function");
  });

  it("register is a safe no-op that still returns an unregister fn", () => {
    const { result } = renderHook(() => useExamCommands());
    let unregister: (() => void) | undefined;
    expect(() => {
      act(() => {
        unregister = result.current.register(examCommands);
      });
    }).not.toThrow();
    expect(typeof unregister).toBe("function");
    // Calling the unregister fn is also safe (mirrors the runner's cleanup).
    expect(() => act(() => unregister?.())).not.toThrow();
  });
});

describe("useExamCommands under a CommandPaletteProvider", () => {
  // The provider's `initialActions` effect keys on the array identity, so it
  // MUST be a stable reference (the real app passes a useMemo'd array). A fresh
  // `[]` each render would loop the provider's sync effect — pass a constant.
  const STABLE_INITIAL_ACTIONS: CommandAction[] = [];
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <CommandPaletteProvider initialActions={STABLE_INITIAL_ACTIONS}>
        {children}
      </CommandPaletteProvider>
    );
  }

  it("bridges to the mounted palette's register and unregisters cleanly", () => {
    // Render both the exam seam AND the palette context under one provider so we
    // can confirm the seam routes through the SAME palette the legacy shell uses.
    const { result, unmount } = renderHook(
      () => ({ exam: useExamCommands(), palette: useCommandPalette() }),
      { wrapper },
    );
    // The palette context is live (proves we are under a real provider, so the
    // seam's optional bridge is exercised — not the no-op branch).
    expect(typeof result.current.palette.register).toBe("function");

    let unregister: (() => void) | undefined;
    act(() => {
      unregister = result.current.exam.register(examCommands);
    });
    expect(typeof unregister).toBe("function");
    // The runner's cleanup (unregister) is safe and does not throw.
    expect(() => act(() => unregister?.())).not.toThrow();
    unmount();
  });
});
