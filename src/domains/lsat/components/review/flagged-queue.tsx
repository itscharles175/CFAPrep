import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Flag } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ListRow } from "@lsat/components/ui/list-row";
import { AnimatedList } from "@lsat/components/ui/animated-list";
import { EmptyState, SkeletonList } from "@lsat/components/states";
import { useMultiSessionResults, reviewableSessions } from "@lsat/lib/hooks/useReviewSessions";
import { unwrap, useSessions } from "@lsat/lib/hooks";
import { qTypeLabel } from "@lsat/lib/labels";

/** R4-B5 — flagged questions across recent sessions. */
export function FlaggedQueue() {
  const navigate = useNavigate();
  const sessions = unwrap(useSessions());
  const list = reviewableSessions(sessions.data ?? []).slice(0, 5);
  const ids = list.map((s) => s.id);
  const multi = useMultiSessionResults(ids);

  const flagged = useMemo(() => {
    const out: { sessionId: number; questionId: number; label: string }[] = [];
    for (const sid of ids) {
      const items = multi.resultsBySessionId.get(sid) ?? [];
      for (const it of items) {
        if (it.attempt.flagged) {
          out.push({
            sessionId: sid,
            questionId: it.question.id,
            label: qTypeLabel(it.question.q_type),
          });
        }
      }
    }
    return out;
  }, [ids, multi.resultsBySessionId]);

  if (multi.isLoading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading flagged questions</span>
        <SkeletonList rows={3} />
      </div>
    );
  }
  if (!flagged.length) {
    return (
      <EmptyState
        title="No flagged questions"
        description="Flag items during a timed section to review them here."
      />
    );
  }

  // R10 — animate add/remove so the list reconciles smoothly when results
  // refetch (e.g. after grading in a sibling tab) instead of hard-cutting.
  // Reduced-motion renders a plain list.
  return (
    <AnimatedList
      className="space-y-2"
      items={flagged}
      getKey={(f, i) => `${f.sessionId}-${f.questionId}-${i}`}
      renderItem={(f) => (
        <ListRow
          leading={<Icon as={Flag} size="sm" className="text-warning" />}
          title={f.label}
          meta={`Session #${f.sessionId}`}
          trailing={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigate(`/explanation/${f.questionId}?session=${f.sessionId}`)
              }
            >
              Review
            </Button>
          }
        />
      )}
    />
  );
}
