/*
 * K4-cmd — neutral exam command-registration seam (Phase 1 of Keystone K4).
 *
 * The section runner (the ~1k-line timed-exam screen) used to depend directly on
 * the LSAT palette's `useCommandPalette()` to register its five exam-scoped
 * affordances (focus mode, overview map, reading size ±, flag). That hard
 * dependency meant the LSAT palette could not be deleted (K4-13) without
 * crashing the runner.
 *
 * This module is the decoupling seam. The runner now imports ONLY
 * `useExamCommands` from here — a neutral hook the runner's own domain owns. It:
 *
 *   - exposes the SAME minimal contract the runner needs (`register(actions)`
 *     returning an unregister fn, `ExamCommand` mirroring the old
 *     `CommandAction`), so the runner's call site is byte-for-byte unchanged in
 *     intent (its exam timing / focus / keyboard behavior is driven entirely by
 *     its own local keydown handler, never by the palette);
 *   - bridges to the LSAT palette OPTIONALLY via `useOptionalCommandPalette()`,
 *     which returns `null` when no `<CommandPaletteProvider>` is mounted. So:
 *       · under the legacy LSAT shell (palette present) → the exam commands
 *         register into the palette exactly as before (identical behavior);
 *       · with no palette (future unified shell / K4-13 deletion) → `register`
 *         is a safe no-op and the runner keeps working.
 *
 * When K4-13 removes the LSAT palette, only the one bridge import below changes
 * (or this file is re-pointed at the unified palette in K4-11); the RUNNER is
 * untouched.
 */

import { useCallback } from "react";
import { useOptionalCommandPalette } from "@lsat/components/command-palette";

/**
 * The exam-command shape the runner registers. Structurally identical to the
 * LSAT palette's `CommandAction` (so a registered command flows straight through
 * when the palette IS present), but declared here so the runner's domain does
 * not depend on the palette's exported type.
 */
export interface ExamCommand {
  id: string;
  label: string;
  group?: string;
  icon?: React.ReactNode;
  keywords?: string[];
  shortcut?: string[];
  perform: () => void;
}

/** What the runner consumes: a `register` with the legacy palette signature. */
export interface ExamCommandRegistry {
  /** Register exam commands; returns an unregister fn. No-op when no palette. */
  register: (commands: ExamCommand[]) => () => void;
}

/**
 * Neutral exam-command registry for the section runner. Bridges to the LSAT
 * command palette when one is mounted, otherwise hands back a no-op `register`
 * so the runner never crashes on a missing provider.
 */
export function useExamCommands(): ExamCommandRegistry {
  const palette = useOptionalCommandPalette();
  const paletteRegister = palette?.register;

  const register = useCallback(
    (commands: ExamCommand[]) => {
      // No palette mounted (unified shell / post-K4-13): registration is a
      // harmless no-op. The runner's local keyboard handler still drives every
      // exam interaction, so behavior is identical with or without the palette.
      if (!paletteRegister) return () => {};
      return paletteRegister(commands);
    },
    [paletteRegister],
  );

  return { register };
}
