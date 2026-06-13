import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

/** Parse "lines 12–15" / "line 3" from RC question prompts. */
export function parseLineRef(text: string): { start: number; end: number } | null {
  const m = text.match(/\blines?\s+(\d+)\s*(?:[-–—]\s*(\d+))?/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return { start, end };
}

function charRangeForLines(passageText: string, startLine: number, endLine: number) {
  const lines = passageText.split("\n");
  let offset = 0;
  for (let i = 0; i < startLine - 1; i++) offset += lines[i].length + 1;
  let endOffset = offset;
  for (let i = startLine - 1; i < endLine; i++) endOffset += lines[i].length + 1;
  return { start: offset, end: endOffset };
}

/** Clickable line-reference chips that scroll/highlight a passage range (Wave 2). */
export function LineReferenceChips({
  prompt,
  passageText,
  onHighlightRange,
}: {
  prompt: string;
  passageText?: string;
  onHighlightRange?: (start: number, end: number) => void;
}) {
  const lineRef = parseLineRef(prompt);

  const jump = useCallback(() => {
    if (!lineRef || !passageText) return;
    const { start, end } = charRangeForLines(
      passageText,
      Math.max(1, lineRef.start),
      Math.min(passageText.split("\n").length, lineRef.end),
    );
    onHighlightRange?.(start, end);
  }, [lineRef, passageText, onHighlightRange]);

  if (!lineRef || !passageText) return null;

  return (
    <button
      type="button"
      onClick={jump}
      className={cn(
        "rounded-md border border-info/40 bg-info/10 px-2 py-0.5 text-xs font-medium text-info",
        "hover:bg-info/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      Jump to lines {lineRef.start}
      {lineRef.end !== lineRef.start ? `–${lineRef.end}` : ""}
    </button>
  );
}

export function usePassageScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  const scrollToRange = useCallback((start: number, end: number) => {
    const root = ref.current;
    if (!root) return;
    const mark = markRef.current;
    if (mark) {
      mark.setAttribute("data-start", String(start));
      mark.setAttribute("data-end", String(end));
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let target: Text | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const len = node.textContent?.length ?? 0;
      if (offset + len > start) {
        target = node;
        break;
      }
      offset += len;
    }
    if (target?.parentElement) {
      target.parentElement.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      root.scrollTop = Math.max(0, (start / Math.max(1, end)) * root.scrollHeight * 0.4);
    }
  }, []);

  return { ref, markRef, scrollToRange };
}

export function PassageScrollPane({
  children,
  scrollRef,
}: {
  children: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      {children}
    </div>
  );
}
