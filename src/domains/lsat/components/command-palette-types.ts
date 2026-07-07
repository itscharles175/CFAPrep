import type { ReactNode } from "react";

export interface CommandAction {
  id: string;
  label: string;
  group?: string;
  /** Optional lucide (or any) icon node. */
  icon?: ReactNode;
  /** Extra search terms (keywords) for fuzzy matching. */
  keywords?: string[];
  /**
   * Optional keyboard-shortcut hint, rendered as keycap chips on the row
   * (e.g. ["⌘/Ctrl", "K"]). Purely informational — does not bind the key.
   */
  shortcut?: string[];
  perform: () => void;
}
