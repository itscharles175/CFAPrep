import { Eraser, Highlighter, StickyNote, Underline } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnnotationStyle } from "./highlightable-text";

// 4.x — swatch hues ride the SAME per-theme `--hl-*` vars the applied highlight
// fills use, so the dot you pick matches the mark you get in every theme (the
// old fixed `bg-yellow/green/pink-400` classes drifted from the green/pink fills
// once those moved to theme tokens). The dot shows the solid pen hue; the fill
// renders that same hue at reading alpha over the text.
const COLORS: {
  value: Extract<AnnotationStyle, "yellow" | "green" | "pink">;
  varName: string;
}[] = [
  { value: "yellow", varName: "--hl-yellow" },
  { value: "green", varName: "--hl-green" },
  { value: "pink", varName: "--hl-pink" },
];

export function HighlighterToolbar({
  active,
  onChange,
  noteMode = false,
  onToggleNote,
}: {
  active: AnnotationStyle | null;
  onChange: (c: AnnotationStyle | null) => void;
  /** Note tool active (selecting text attaches a margin note). */
  noteMode?: boolean;
  onToggleNote?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-card p-1">
      <Highlighter className="mx-1 h-4 w-4 text-muted-foreground" />
      {COLORS.map((c) => {
        const isActive = active === c.value && !noteMode;
        return (
          <button
            key={c.value}
            title={`Highlight ${c.value}`}
            aria-label={`Highlight ${c.value}`}
            aria-pressed={isActive}
            onClick={() => onChange(isActive ? null : c.value)}
            style={{ backgroundColor: `hsl(var(${c.varName}))` }}
            className={cn(
              "h-6 w-6 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              isActive ? "scale-110 border-foreground" : "border-transparent",
            )}
          />
        );
      })}
      <button
        title="Underline"
        aria-label="Underline"
        aria-pressed={active === "underline" && !noteMode}
        onClick={() => onChange(active === "underline" && !noteMode ? null : "underline")}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active === "underline" && !noteMode && "bg-accent text-primary",
        )}
      >
        <Underline className="h-3.5 w-3.5" />
      </button>
      <button
        title="Eraser"
        aria-label="Eraser"
        aria-pressed={active === null && !noteMode}
        onClick={() => onChange(active === null && !noteMode ? "yellow" : null)}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active === null && !noteMode && "bg-accent",
        )}
      >
        <Eraser className="h-3.5 w-3.5" />
      </button>
      {onToggleNote && (
        <button
          title="Add margin note to a selection"
          aria-label="Add margin note to a selection"
          aria-pressed={noteMode}
          onClick={onToggleNote}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            noteMode && "bg-primary text-primary-foreground",
          )}
        >
          <StickyNote className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
