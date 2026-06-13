import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  HighlightableText,
  type AnnotationStyle,
  type Highlight,
} from "./highlightable-text";
import { newNoteId, type MarginNote } from "@/lib/prefs";

/**
 * Stimulus/passage text with highlights + underline + margin notes (docs/06
 * §4.3). Notes are anchored to a selection and persisted by the parent via the
 * useNotes hook. In `readOnly` mode (review screens) saved notes resurface
 * beneath the text.
 */
function AnnotatedTextImpl({
  text,
  highlights,
  onHighlightsChange,
  activeColor,
  noteMode = false,
  notes,
  onNotesChange,
  className,
  readOnly = false,
}: {
  text: string;
  highlights: Highlight[];
  onHighlightsChange?: (h: Highlight[]) => void;
  activeColor: AnnotationStyle | null;
  noteMode?: boolean;
  notes: MarginNote[];
  onNotesChange?: (n: MarginNote[]) => void;
  className?: string;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<{
    start: number;
    end: number;
    quote: string;
    body: string;
  } | null>(null);

  // Managed focus (replaces the `autoFocus` prop, which jsx-a11y flags): when a
  // note draft opens, move focus to its textarea so keyboard users land in the
  // composer — without the autofocus pitfalls of stealing focus on every mount.
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const hasDraft = draft !== null;
  useEffect(() => {
    if (hasDraft) draftRef.current?.focus();
  }, [hasDraft]);

  // A2.2 — stabilize the props handed to the (memoized) HighlightableText so its
  // memo boundary actually holds: a stable callback + a memoized anchors array
  // (recomputed only when `notes` change), instead of fresh values each render.
  const handleSelectRange = useCallback(
    (r: { start: number; end: number; quote: string }) =>
      setDraft({ ...r, body: "" }),
    [],
  );
  const noteAnchors = useMemo(
    () => notes.map((n) => ({ start: n.start, end: n.end })),
    [notes],
  );

  function saveDraft() {
    if (!draft || !onNotesChange) return;
    const note: MarginNote = {
      id: newNoteId(),
      start: draft.start,
      end: draft.end,
      quote: draft.quote,
      body: draft.body.trim(),
      createdAt: Date.now(),
    };
    if (note.body) onNotesChange([...notes, note].sort((a, b) => a.start - b.start));
    setDraft(null);
  }

  function removeNote(id: string) {
    onNotesChange?.(notes.filter((n) => n.id !== id));
  }

  return (
    <div>
      <HighlightableText
        text={text}
        highlights={highlights}
        activeColor={activeColor}
        onChange={onHighlightsChange}
        noteMode={noteMode && !readOnly}
        onSelectRange={handleSelectRange}
        noteAnchors={noteAnchors}
        readOnly={readOnly}
        className={className}
      />

      {/* Note composer (appears after selecting text in note mode). */}
      {draft && !readOnly && (
        <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
            <StickyNote className="h-3.5 w-3.5" /> Note on “{truncate(draft.quote)}”
          </div>
          <Textarea
            ref={draftRef}
            value={draft.body}
            placeholder="Your note…"
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            className="min-h-[60px]"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveDraft} disabled={!draft.body.trim()}>
              Save note
            </Button>
          </div>
        </div>
      )}

      {/* Saved notes list — resurfaces in review (§4.3). */}
      {notes.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="type-overline text-muted-foreground">
            Margin notes
          </div>
          {notes.map((n) => (
            <div
              key={n.id}
              className="rounded-md border bg-card p-2.5 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="text-xs italic text-muted-foreground">
                    “{truncate(n.quote)}”
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">{n.body}</div>
                </div>
                {!readOnly && onNotesChange && (
                  <button
                    onClick={() => removeNote(n.id)}
                    title="Delete note"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A2.2 — memoized. Wraps the hot HighlightableText; with stable props from
 * SectionRunner (text per-question, `highlights`/`notes` from state, callbacks
 * `useCallback`-stable) a parent re-render unrelated to the passage (flag, clock
 * tick now isolated, etc.) skips re-rendering the annotated passage entirely.
 */
export const AnnotatedText = memo(AnnotatedTextImpl);

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
