// LSAT-6 — inline margin-note / explanation authoring.
//
// A self-contained editor for the user-authored explanation + free tags attached
// to a question's annotation. Deliberately SEPARATE from the highlighter toolbar
// (highlightable-text.tsx / highlighter-toolbar.tsx): that toolbar owns
// selection-based highlights & anchored margin notes; this is a plain
// title-free prose + tag surface keyed by question id, mounted on Review/Bank
// and beside the AI explanation. It never reads or mutates the highlight/note
// localStorage that the toolbar owns, so the two cannot collide.
//
// Local-first: the explanation + tags persist to localStorage immediately so the
// editor works fully offline. When a backend `annotationId` is supplied, writes
// ALSO best-effort sync to the LSAT backend (annotationSync.ts) so the KB FTS
// index + backlinks stay current — a failed sync never blocks the local save.

import { useEffect, useMemo, useState } from "react";
import { PencilLine, Tag, X } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Input } from "@lsat/components/ui/input";
import { Textarea } from "@lsat/components/ui/textarea";
import { getJSON, getRaw, setJSON, setRaw } from "@lsat/lib/storage";
import { syncExplanation, syncTags } from "@lsat/lib/annotationSync";
import { cn } from "@lsat/lib/utils";

// On-disk contract (per-question, mirrors the lsatlab.notes.{id} prefix style).
const EXPLANATION_PREFIX = "lsatlab.userExplanation.";
const TAGS_PREFIX = "lsatlab.annotationTags.";

export function getUserExplanation(questionId: number): string {
  return getRaw(EXPLANATION_PREFIX + questionId) ?? "";
}

export function getAnnotationTags(questionId: number): string[] {
  const arr = getJSON<string[]>(TAGS_PREFIX + questionId, []);
  return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
}

export interface AnnotationInlineEditorProps {
  questionId: number;
  /** Backend annotation id, when known — enables the optional FTS/backlink sync. */
  annotationId?: number | null;
  /** Compact variant (Bank rows) trims the heading + padding. */
  compact?: boolean;
  className?: string;
  /** Fired after a successful local save (and attempted sync). */
  onSaved?: (next: { userExplanation: string; tags: string[] }) => void;
}

/**
 * Inline editor for a question's user-authored explanation + tags. Reads the
 * persisted values on mount, saves to localStorage on "Save", and (when an
 * annotationId is given) mirrors to the backend KB.
 */
export function AnnotationInlineEditor({
  questionId,
  annotationId = null,
  compact = false,
  className,
  onSaved,
}: AnnotationInlineEditorProps) {
  const initial = useMemo(
    () => ({
      explanation: getUserExplanation(questionId),
      tags: getAnnotationTags(questionId),
    }),
    [questionId],
  );

  const [explanation, setExplanation] = useState(initial.explanation);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-hydrate when the question changes (the component may stay mounted).
  useEffect(() => {
    setExplanation(initial.explanation);
    setTags(initial.tags);
    setTagDraft("");
    setSaved(false);
  }, [initial]);

  function addTag() {
    const t = tagDraft.trim();
    if (!t) return;
    if (!tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagDraft("");
    setSaved(false);
  }

  function removeTag(t: string) {
    setTags((prev) => prev.filter((x) => x !== t));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    const trimmed = explanation.trim();
    // Local-first: persist immediately (this is the offline-always path).
    setRaw(EXPLANATION_PREFIX + questionId, trimmed);
    setJSON(TAGS_PREFIX + questionId, tags);
    // Optional backend mirror — best-effort, never blocks the local save.
    if (annotationId != null) {
      await Promise.allSettled([
        syncExplanation(annotationId, trimmed),
        syncTags(annotationId, tags),
      ]);
    }
    setBusy(false);
    setSaved(true);
    onSaved?.({ userExplanation: trimmed, tags });
  }

  const dirty =
    explanation.trim() !== initial.explanation.trim() ||
    tags.join("") !== initial.tags.join("");

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border bg-card",
        compact ? "p-3" : "p-4",
        className,
      )}
    >
      {!compact && (
        <div className="flex items-center gap-2">
          <PencilLine className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Your explanation</h3>
        </div>
      )}
      <Textarea
        value={explanation}
        onChange={(e) => {
          setExplanation(e.target.value);
          setSaved(false);
        }}
        rows={compact ? 3 : 4}
        placeholder="Write your own explanation in your words — what's the trap, what's the tell, how do you spot it next time?"
        aria-label="Your explanation for this question"
        className="resize-y text-sm"
      />

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="h-3.5 w-3.5 text-muted-foreground" />
          {tags.length === 0 && (
            <span className="text-xs text-muted-foreground">No tags yet</span>
          )}
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-1">
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => removeTag(t)}
                className="rounded-full p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add a tag (e.g. causal-reversal)"
            aria-label="Add a tag"
            className="h-8 text-sm"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addTag}
            disabled={!tagDraft.trim()}
          >
            Add
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {saved && !dirty && (
          <span className="text-xs text-success">Saved</span>
        )}
        <Button
          type="button"
          size="sm"
          onClick={save}
          loading={busy}
          disabled={busy || !dirty}
        >
          {busy ? "Saving…" : "Save note"}
        </Button>
      </div>
    </div>
  );
}
