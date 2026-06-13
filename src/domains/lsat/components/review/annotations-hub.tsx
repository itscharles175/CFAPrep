import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Highlighter, PencilLine, StickyNote } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { EmptyState } from "@lsat/components/states";
import { aggregateAnnotations } from "@lsat/lib/annotationsHub";

/**
 * R7 6.2 — Annotations & notes review hub. Aggregates every highlight, margin
 * note, and scratchpad entry the user has written across sessions, grouped by
 * question (highlights + notes) and by section (scratch). Each question card
 * links back to /explanation/{questionId}.
 */
export function AnnotationsHub() {
  const navigate = useNavigate();
  // localStorage is not reactive; read once when the hub mounts. Navigating
  // away and back (tab switch unmounts content) re-reads.
  const agg = useMemo(() => aggregateAnnotations(), []);

  if (agg.isEmpty) {
    return (
      <EmptyState
        illustration={<StickyNote className="h-10 w-10 text-muted-foreground" />}
        title="No annotations yet"
        description="Highlights, margin notes, and scratch work you make while practicing show up here, grouped by question."
      />
    );
  }

  return (
    <div className="space-y-6">
      {agg.questions.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Highlighter className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Highlights &amp; notes</h3>
            <span className="text-xs text-muted-foreground">
              {agg.questions.length} question{agg.questions.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-2">
            {agg.questions.map((q) => (
              <Card key={q.questionId}>
                <CardContent className="space-y-2 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Question #{q.questionId}</Badge>
                      {q.highlights.length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Highlighter className="h-3 w-3" />
                          {q.highlights.length} highlight{q.highlights.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {q.notes.length > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <StickyNote className="h-3 w-3" />
                          {q.notes.length} note{q.notes.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/explanation/${q.questionId}`)}
                    >
                      Open
                    </Button>
                  </div>
                  {q.notes.length > 0 && (
                    <ul className="space-y-1.5">
                      {q.notes.map((n) => (
                        <li key={n.id} className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                          {n.quote && (
                            <p className="mb-0.5 line-clamp-2 border-l-2 border-primary/40 pl-2 text-xs italic text-muted-foreground">
                              {n.quote}
                            </p>
                          )}
                          <p className="whitespace-pre-wrap">{n.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {agg.scratch.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <PencilLine className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Scratch work</h3>
            <span className="text-xs text-muted-foreground">by section</span>
          </div>
          <div className="space-y-2">
            {agg.scratch.map((s) => (
              <Card key={s.sectionId}>
                <CardContent className="space-y-1.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Section #{s.sectionId}</Badge>
                    {s.strokeCount > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <FileText className="h-3 w-3" />
                        {s.strokeCount} drawing stroke{s.strokeCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {s.text.trim() && (
                    <p className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      {s.text}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
