import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  actionLabel,
  getKeyboardMap,
  type ExamKeyAction,
} from "@/lib/keyboardMap";

interface Shortcut {
  keys: string[];
  label: string;
}

/** Custom event other components (e.g. the command palette) dispatch to open this. */
export const KEYBOARD_HELP_EVENT = "lsatlab:keyboard-help";

const GLOBAL_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘/Ctrl", "K"], label: "Open command palette" },
      { keys: ["?"], label: "Show / hide this help" },
      { keys: ["Esc"], label: "Close dialogs & overlays" },
    ],
  },
  {
    title: "Exam — reading",
    items: [
      { keys: ["Reading"], label: "Open reading controls (size, serif, presets)" },
      { keys: ["⌘/Ctrl", "K"], label: "Command palette: focus mode, font size ±" },
    ],
  },
];

function formatKey(k: string): string {
  if (k.startsWith("Arrow")) return k.replace("Arrow", "");
  return k.length === 1 ? k.toUpperCase() : k;
}

function examGroupsFromMap(): { title: string; items: Shortcut[] }[] {
  const map = getKeyboardMap();
  const actions: ExamKeyAction[] = [
    "answer_A",
    "answer_B",
    "answer_C",
    "answer_D",
    "answer_E",
    "flag",
    "prev",
    "next",
  ];
  return [
    {
      title: "Exam — answering (your bindings)",
      items: [
        ...actions
          .filter((a) => a.startsWith("answer_") || a === "flag")
          .map((a) => ({
            keys: [formatKey(map[a])],
            label: actionLabel(a),
          })),
        {
          keys: ["Shift", formatKey(map.answer_E)],
          label: "Eliminate / un-eliminate selected choice",
        },
      ],
    },
    {
      title: "Exam — navigation (your bindings)",
      items: [
        { keys: [formatKey(map.prev)], label: actionLabel("prev") },
        { keys: [formatKey(map.next)], label: actionLabel("next") },
        { keys: ["1", "–", "9"], label: "Jump to question by number" },
      ],
    },
  ];
}

/** Shared keycap chip — also reused by the command palette (R8). */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-muted-foreground shadow-e1">
      {children}
    </kbd>
  );
}

/** Keyboard-shortcut help overlay — reflects persisted exam map (R4-C10). */
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = [...GLOBAL_GROUPS, ...examGroupsFromMap()];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(KEYBOARD_HELP_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(KEYBOARD_HELP_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (s) =>
              s.label.toLowerCase().includes(q) ||
              g.title.toLowerCase().includes(q) ||
              s.keys.some((k) => k.toLowerCase().includes(q)),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : groups;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press ? anytime. Exam keys match Settings → Keyboard shortcuts.
          </DialogDescription>
        </DialogHeader>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter shortcuts…"
          aria-label="Filter keyboard shortcuts"
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No matching shortcuts.
            </p>
          )}
          {filtered.map((g) => (
            <div key={g.title}>
              <div className="type-overline mb-2 text-muted-foreground">
                {g.title}
              </div>
              <div className="space-y-1.5">
                {g.items.map((s) => (
                  <div
                    key={s.label}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>{s.label}</span>
                    <span className="flex flex-shrink-0 items-center gap-1">
                      {s.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
