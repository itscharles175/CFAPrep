import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";

// G7 — lazy-load the cmdk dialog body so cmdk (~35 KB) is excluded from the
// initial bundle and only fetched the first time the palette is opened.
const CommandPaletteDialog = lazy(
  () => import("@lsat/components/command-palette-dialog"),
);

export interface CommandAction {
  id: string;
  label: string;
  group?: string;
  /** Optional lucide (or any) icon node. */
  icon?: React.ReactNode;
  /** Extra search terms (keywords) for fuzzy matching. */
  keywords?: string[];
  /**
   * Optional keyboard-shortcut hint, rendered as keycap chips on the row
   * (e.g. ["⌘/Ctrl", "K"]). Purely informational — does not bind the key.
   */
  shortcut?: string[];
  perform: () => void;
}

interface CommandPaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  /** Register actions; returns an unregister fn. Later waves extend the list. */
  register: (actions: CommandAction[]) => () => void;
}

const Ctx = createContext<CommandPaletteState | null>(null);


export function useCommandPalette() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommandPalette must be used within <CommandPaletteProvider>");
  return ctx;
}

export function CommandPaletteProvider({
  children,
  initialActions = [],
}: {
  children: React.ReactNode;
  initialActions?: CommandAction[];
}) {
  const [open, setOpen] = useState(false);
  const [registries, setRegistries] = useState<CommandAction[][]>([initialActions]);

  const register = useCallback((actions: CommandAction[]) => {
    setRegistries((r) => [...r, actions]);
    return () => setRegistries((r) => r.filter((a) => a !== actions));
  }, []);

  // Keep the first registry slot in sync with initialActions so theme/mode
  // toggles and the Recents list don't freeze at their first-render values.
  // (App passes a useMemo'd array, so this only fires when it actually changes.)
  useEffect(() => {
    setRegistries((r) => [initialActions, ...r.slice(1)]);
  }, [initialActions]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // ⌘K / Ctrl-K global shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  const actions = useMemo(() => registries.flat(), [registries]);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, CommandAction[]>();
    for (const a of actions) {
      const g = a.group ?? "Actions";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(a);
    }
    return Array.from(byGroup.entries());
  }, [actions]);

  // R10 A2.5 — memoize the context value (this provider wraps the whole app, so
  // an inline object re-rendered every consumer — incl. the exam screen — on any
  // register/open change).
  const value = useMemo<CommandPaletteState>(
    () => ({ open, setOpen, toggle, register }),
    [open, toggle, register],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* G7 — the dialog body is lazy so cmdk is off the critical path. The
          Suspense fallback is null: the dialog is only mounted when open is
          true, so a brief null while the chunk loads is invisible to the user
          (the keyboard shortcut triggers the load; the palette appears once
          the chunk resolves, typically <100 ms on first open). */}
      <Suspense fallback={null}>
        <CommandPaletteDialog
          open={open}
          onOpenChange={setOpen}
          grouped={grouped}
        />
      </Suspense>
    </Ctx.Provider>
  );
}
