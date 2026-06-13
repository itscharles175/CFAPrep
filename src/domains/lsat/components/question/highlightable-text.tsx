import { memo, useCallback, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

export type HighlightColor = "yellow" | "green" | "pink" | null;

/** Annotation styles. `underline` is a non-color emphasis (docs/06 §4.3). */
export type AnnotationStyle = Exclude<HighlightColor, null> | "underline";

export interface Highlight {
  start: number;
  end: number;
  /** Highlight color OR an underline. Older saved data only had colors. */
  color: AnnotationStyle;
}

// yellow/green/pink map to the existing index.css highlight classes; underline
// is applied inline (no new global CSS, per constraints).
const COLOR_CLASS: Partial<Record<AnnotationStyle, string>> = {
  yellow: "hl-yellow",
  green: "hl-green",
  pink: "hl-pink",
};

/** A range that should be visually marked as having a margin note. */
export interface NoteAnchor {
  start: number;
  end: number;
}

interface Segment {
  text: string;
  style: AnnotationStyle | null;
  note: boolean;
  /** Absolute start offset within the passage text — used as stable React key. */
  start: number;
}

/**
 * 4.1 — split the source text into paragraph BLOCKS on blank-line boundaries
 * while preserving every character (so absolute highlight/note offsets and the
 * `\n`-counting line-reference math stay valid). Each block keeps its content
 * range AND the run of separator newlines that follows it; the separators are
 * carried at the END of the same block so the two rendered `<p>` elements remain
 * adjacent siblings (engaging `.reading p + p`) and the concatenated DOM text
 * content is byte-for-byte identical to the input. A single `\n` is treated as a
 * soft line break and stays inside its paragraph (RC line layout is preserved by
 * `whitespace-pre-wrap`); only runs of 2+ newlines start a new paragraph.
 */
export interface TextBlock {
  /** Inclusive start / exclusive end of the visible paragraph content. */
  contentStart: number;
  contentEnd: number;
  /** The separator newlines after the content (may be empty). */
  sepStart: number;
  sepEnd: number;
}

export function splitParagraphBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // A separator is a run of 2+ newlines (optionally with intervening spaces/tabs
  // on the blank line) — the on-disk convention for paragraph breaks. The `\r?`
  // tolerates CRLF passages; offsets stay exact since the match (incl. any \r) is
  // tiled into a separator block, so every source character is still accounted for.
  const sepRe = /\r?\n[ \t]*\r?\n[\s]*/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(text)) !== null) {
    blocks.push({
      contentStart: cursor,
      contentEnd: m.index,
      sepStart: m.index,
      sepEnd: m.index + m[0].length,
    });
    cursor = m.index + m[0].length;
  }
  blocks.push({
    contentStart: cursor,
    contentEnd: text.length,
    sepStart: text.length,
    sepEnd: text.length,
  });
  return blocks;
}

/**
 * Renders text with character-range annotations (highlight colors + underline).
 * Selecting text applies the active tool:
 *  - a color/underline → adds that annotation
 *  - null (eraser) → clears overlapping annotations
 *  - onSelectRange (note tool) → reports the selection to the parent instead of
 *    mutating annotations, so a margin note can be attached.
 */
function HighlightableTextImpl({
  text,
  highlights,
  activeColor,
  onChange,
  className,
  readOnly = false,
  noteMode = false,
  onSelectRange,
  noteAnchors = [],
}: {
  text: string;
  highlights: Highlight[];
  activeColor: AnnotationStyle | null;
  onChange?: (next: Highlight[]) => void;
  className?: string;
  readOnly?: boolean;
  /** When true, a text selection is reported via onSelectRange instead of highlighting. */
  noteMode?: boolean;
  onSelectRange?: (range: { start: number; end: number; quote: string }) => void;
  /** Ranges that carry a margin note (rendered with a subtle marker). */
  noteAnchors?: NoteAnchor[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 4.5 — guard against the same selection being committed twice when both
  // pointerup and the legacy mouseup fire for a mouse gesture.
  const lastApplied = useRef<{ start: number; end: number; at: number } | null>(
    null,
  );

  // Commit the current text selection as a highlight/note. Works for mouse, pen
  // and touch — `onPointerUp` covers all input types; we also keep `onMouseUp`
  // for engines that suppress pointer events during a touch text-selection
  // gesture. The dedupe below stops a mouse gesture from applying twice.
  const handleSelectionEnd = useCallback(() => {
    if (readOnly) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return;
    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) return;

    // Compute character offsets relative to the container's text content.
    const pre = range.cloneRange();
    pre.selectNodeContents(containerRef.current);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const quote = range.toString();
    const end = start + quote.length;
    if (end <= start) return;

    // Skip a duplicate fire for the identical range within a short window.
    const prev = lastApplied.current;
    if (prev && prev.start === start && prev.end === end && Date.now() - prev.at < 500) {
      return;
    }
    lastApplied.current = { start, end, at: Date.now() };

    if (noteMode) {
      onSelectRange?.({ start, end, quote });
      sel.removeAllRanges();
      return;
    }

    if (!onChange) return;
    if (activeColor === null) {
      // Eraser: drop annotations overlapping the selection.
      onChange(highlights.filter((h) => h.end <= start || h.start >= end));
    } else {
      // Remove overlaps, then add the new annotation (no merge for simplicity).
      const kept = highlights.filter((h) => h.end <= start || h.start >= end);
      onChange(
        [...kept, { start, end, color: activeColor }].sort(
          (a, b) => a.start - b.start,
        ),
      );
    }
    sel.removeAllRanges();
  }, [activeColor, highlights, onChange, readOnly, noteMode, onSelectRange]);

  // Build styled segments for a [lo, hi) window. We split on every annotation /
  // note boundary that falls inside the window so a segment can carry both an
  // annotation style and a note marker. Slicing always uses absolute offsets, so
  // a segment's characters are identical whether it is rendered flat or grouped
  // into a paragraph.
  const segmentsFor = (lo: number, hi: number): Segment[] => {
    if (hi <= lo) return [];
    const boundaries = new Set<number>([lo, hi]);
    for (const h of highlights) {
      if (h.end > lo && h.start < hi) {
        boundaries.add(Math.max(lo, Math.min(hi, h.start)));
        boundaries.add(Math.max(lo, Math.min(hi, h.end)));
      }
    }
    for (const a of noteAnchors) {
      if (a.end > lo && a.start < hi) {
        boundaries.add(Math.max(lo, Math.min(hi, a.start)));
        boundaries.add(Math.max(lo, Math.min(hi, a.end)));
      }
    }
    const stops = Array.from(boundaries).sort((a, b) => a - b);
    const out: Segment[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const s = stops[i];
      const e = stops[i + 1];
      if (e <= s) continue;
      const hit = highlights.find((h) => h.start <= s && h.end >= e);
      const noted = noteAnchors.some((a) => a.start <= s && a.end >= e);
      out.push({ text: text.slice(s, e), style: hit?.color ?? null, note: noted, start: s });
    }
    return out;
  };

  // Group into paragraph blocks (4.1). The separator newlines after a block are
  // rendered (kept in the DOM for offset/line-reference fidelity) but visually
  // collapsed via `whitespace-normal`, so the calm inter-paragraph rhythm comes
  // from `.reading p + p`, not from stacked blank lines.
  //
  // A2.2 — memoized on `text`. Paragraph segmentation depends ONLY on the source
  // text, never on highlights/notes, so it is re-run only when the passage/stem
  // actually changes — not on every highlight edit (and, with the component now
  // `memo`-wrapped, never on the 1-second clock tick).
  const blocks = useMemo(() => splitParagraphBlocks(text), [text]);

  return (
    // This is a readable text surface, not a click target: the pointer/mouse
    // handlers only READ the user's native text selection (window.getSelection)
    // to turn it into a highlight/note. Native selection is itself keyboard-
    // accessible (Shift+Arrows), and the highlighter toolbar + exam keyboard map
    // provide the non-pointer affordances, so a separate interactive role would
    // misrepresent the element. The rule is a false positive for selection-only
    // handlers, disabled here only.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={containerRef}
      onMouseUp={handleSelectionEnd}
      onPointerUp={(e) => {
        // Mouse is handled by onMouseUp (unchanged). Pen/touch come through
        // here; some engines fire pointerup before the selection settles, so
        // defer a tick to read the finalized selection.
        if (e.pointerType === "mouse") return;
        const run = () => handleSelectionEnd();
        if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
          window.requestAnimationFrame(run);
        } else {
          run();
        }
      }}
      className={cn(
        // C5 — break overlong unbroken tokens (e.g. a pasted URL) so they wrap
        // instead of forcing horizontal scroll in the RC pane. Purely visual:
        // highlight/note offsets are character-based, so wrapping is offset-safe.
        "select-text leading-relaxed [overflow-wrap:anywhere]",
        !readOnly && "cursor-text",
        className,
      )}
    >
      {blocks.map((block) => {
        const content = segmentsFor(block.contentStart, block.contentEnd);
        // The separator is built through the SAME segment pipeline so a highlight
        // crossing a paragraph boundary tints the gap consistently.
        const sepSegments = segmentsFor(block.sepStart, block.sepEnd);
        return (
          // Each paragraph keeps `whitespace-pre-wrap` so soft single-newline
          // line breaks inside a paragraph (e.g. line-numbered RC) survive.
          <p key={block.contentStart} className="whitespace-pre-wrap">
            {content.map((seg) => renderSegment(seg))}
            {/* Separator newlines: preserved in the DOM so absolute offsets and
                the `\n`-based line-reference math stay correct, but rendered with
                `whitespace-normal` so they collapse instead of stacking blank
                lines. Kept INSIDE this paragraph so the next `<p>` is an adjacent
                sibling and `.reading p + p` spacing engages. */}
            {sepSegments.length > 0 && (
              <span aria-hidden className="whitespace-normal">
                {sepSegments.map((seg) => renderSegment(seg))}
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}

/**
 * A2.2 — memoized. This is the hottest component in the timed section: it runs
 * `splitParagraphBlocks(text)` + per-paragraph boundary scans. With the 1-second
 * clock now isolated (A2.1) the parent no longer re-renders it every tick, and
 * this `memo` boundary additionally skips re-renders whose props are unchanged.
 * Props from AnnotatedText are stabilized (`onSelectRange`/`noteAnchors` are
 * `useCallback`/`useMemo`) so the boundary actually holds.
 */
export const HighlightableText = memo(HighlightableTextImpl);

function renderSegment(seg: Segment) {
  return (
    <span
      key={seg.start}
      className={cn(seg.style && COLOR_CLASS[seg.style])}
      style={{
        ...(seg.style === "underline"
          ? {
              textDecorationLine: "underline",
              textDecorationThickness: "2px",
              textDecorationColor: "hsl(var(--primary))",
              textUnderlineOffset: "2px",
            }
          : {}),
        ...(seg.note
          ? {
              boxShadow: "inset 0 -2px 0 0 hsl(var(--primary) / 0.5)",
              cursor: "help",
            }
          : {}),
      }}
      title={seg.note ? "Has a margin note" : undefined}
    >
      {seg.text}
    </span>
  );
}
