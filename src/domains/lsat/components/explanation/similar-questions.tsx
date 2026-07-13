import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ListPlus } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { api } from "@lsat/lib/api";
import { qTypeLabel } from "@lsat/lib/labels";
import { useBulkSrsCards } from "@lsat/lib/mutations";
import type { Question } from "@lsat/lib/types";

/** R4-A4 / D9 — similar questions carousel + batch SRS queue. */
export function SimilarQuestions({
  questionId,
  qType,
}: {
  questionId: number;
  qType?: string;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [queued, setQueued] = useState(false);
  const bulkSrs = useBulkSrsCards();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.questionSimilar(questionId);
        if (!cancelled) setItems(res.slice(0, 5));
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questionId, qType]);

  if (!items.length) return null;

  const q = items[index];

  function addAllToSrs() {
    // Create real SRS cards via the backend (the mutation toasts the created
    // count and invalidates the due queue) instead of the old write-only
    // localStorage queue that nothing ever read.
    bulkSrs.mutate(
      items.map((it) => it.id),
      { onSuccess: () => setQueued(true) },
    );
  }

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Similar questions</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={addAllToSrs}
            disabled={queued || bulkSrs.isPending}
          >
            <ListPlus className="h-3.5 w-3.5" />
            Add all to SRS
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={index === 0}
            onClick={() => setIndex((i) => i - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {index + 1}/{items.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={index >= items.length - 1}
            onClick={() => setIndex((i) => i + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {q.q_type && <Badge variant="outline">{qTypeLabel(q.q_type)}</Badge>}
        <p className="line-clamp-2 text-xs text-muted-foreground">{q.stem}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate(`/explanation/${q.id}`)}
        >
          Open
        </Button>
      </div>
    </div>
  );
}
