import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Search } from "lucide-react";
import { Input } from "@lsat/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lsat/components/ui/tabs";
import { PageLayout } from "@lsat/components/page-layout";
import { ListRow } from "@lsat/components/ui/list-row";
import { AnimatedList } from "@lsat/components/ui/animated-list";
import { EmptyState, SkeletonCard, SkeletonList } from "@lsat/components/states";
import { IllustrationSrsCaughtUp } from "@lsat/components/illustrations";
import { TypeBadge } from "@lsat/components/viz";
import { SessionRecap } from "@lsat/components/motivation";
import { BucketQueue } from "@lsat/components/review/bucket-queue";
import { FlaggedQueue } from "@lsat/components/review/flagged-queue";
import { ErrorLogWorkspace } from "@lsat/components/review/error-log-workspace";
import { ErrorPatternBanner } from "@lsat/components/review/error-pattern-banner";
import { AnnotationsHub } from "@lsat/components/review/annotations-hub";
import { AnnotationInlineEditor } from "@lsat/components/review/annotation-inline-editor";
import { searchAnnotationsKb } from "@lsat/lib/annotationsHub";
import type { AnnotationSearchHit } from "@lsat/lib/types";
import { DockedCoach } from "@lsat/components/coach/docked-coach";
import { useSessionResults, useSessions, useSrsDue } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import { enqueue } from "@lsat/lib/offlineQueue";
import { toast } from "@lsat/lib/toast";
import { Button } from "@lsat/components/ui/button";
import { useNavigate } from "react-router-dom";
import type { SrsDue } from "@lsat/lib/types";

/** R4-B5 — unified review inbox. */
export default function Review() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "buckets";
  const navigate = useNavigate();
  const srs = useSrsDue();
  const due = srs.data?.data.due_count ?? 0;

  return (
    <PageLayout
      title="Review"
      eyebrow="CLOSE THE LOOP"
      icon={ClipboardCheck}
      description="Blind-review buckets, error log, and SRS — close the loop after timed work."
      width="lg"
      actions={
        <Button variant="outline" size="sm" onClick={() => navigate("/review/history")}>
          Session history
        </Button>
      }
    >
      <ErrorPatternBanner />
      <RecentSessionRecap />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="buckets">Buckets</TabsTrigger>
          <TabsTrigger value="errors">Error log</TabsTrigger>
          <TabsTrigger value="flagged">Flagged</TabsTrigger>
          <TabsTrigger value="annotations">Annotations</TabsTrigger>
          <TabsTrigger value="srs">SRS {due > 0 ? `(${due})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="buckets">
          <BucketQueue />
        </TabsContent>
        <TabsContent value="errors">
          <ErrorLogWorkspace />
        </TabsContent>
        <TabsContent value="flagged">
          <FlaggedQueue />
        </TabsContent>
        <TabsContent value="annotations">
          <AnnotationsTab />
        </TabsContent>
        <TabsContent value="srs">
          <SrsInlineQueue />
        </TabsContent>
      </Tabs>
      <DockedCoach scope="review" />
    </PageLayout>
  );
}

const SRS_RATINGS = [
  { r: 1 as const, label: "Again" },
  { r: 2 as const, label: "Hard" },
  { r: 3 as const, label: "Good" },
  { r: 4 as const, label: "Easy" },
];

/** D1/L8 — inline due-card queue: rate from memory without leaving Review. */
function SrsInlineQueue() {
  const srs = useSrsDue();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cards = srs.data?.data.cards ?? [];

  // R10 A4.1 — optimistic inline grading. Same review contract (one
  // /srs/{card}/review per grade, same FSRS rating) — only the timing changes:
  // the card leaves the queue instantly (envelope-aware cache edit), the review
  // fires in the background, and on failure we restore the card and queue the
  // grade offline so it syncs later. `srs-due` is always re-invalidated to
  // reconcile with the server.
  function rate(cardId: number, r: 1 | 2 | 3 | 4) {
    const prev = qc.getQueryData<{ data: SrsDue; usingSample: boolean }>([
      "srs-due",
    ]);
    // Drop the graded card and reflect one fewer due immediately.
    qc.setQueryData<{ data: SrsDue; usingSample: boolean }>(
      ["srs-due"],
      (cur) =>
        cur
          ? {
              ...cur,
              data: {
                ...cur.data,
                cards: cur.data.cards.filter((c) => c.card_id !== cardId),
                due_count: Math.max(0, cur.data.due_count - 1),
              },
            }
          : cur,
    );

    void api
      .srsReview(cardId, r)
      .then(() => {
        toast.success("Review scheduled");
      })
      .catch(() => {
        // Roll the card back into the queue, then persist the grade offline.
        if (prev) qc.setQueryData(["srs-due"], prev);
        enqueue({ kind: "srsReview", cardId, rating: r });
        toast.warning("Saved offline — review will sync when backend is back");
      })
      .finally(() => {
        void qc.invalidateQueries({ queryKey: ["srs-due"] });
      });
  }

  if (srs.isLoading) return <SkeletonList rows={3} />;
  if (!cards.length)
    return (
      <EmptyState
        illustration={<IllustrationSrsCaughtUp />}
        title="All caught up on SRS"
        description="No cards due right now — resurfaced misses will appear here."
      />
    );

  return (
    <AnimatedList
      className="space-y-2"
      items={cards}
      getKey={(c) => c.card_id}
      renderItem={(c) => (
        <ListRow
          leading={<TypeBadge qType={c.q_type} />}
          title={c.prompt || c.stem}
          trailing={
            <>
              {SRS_RATINGS.map(({ r, label }) => (
                <Button
                  key={r}
                  size="sm"
                  variant={r >= 3 ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => rate(c.card_id, r)}
                >
                  {label}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => navigate(`/explanation/${c.id}`)}
              >
                Open
              </Button>
            </>
          }
        />
      )}
    />
  );
}

function RecentSessionRecap() {
  const [params] = useSearchParams();
  const sessionParam = Number(params.get("session") || 0);
  const sessions = useSessions();
  const recent =
    sessionParam > 0
      ? (sessions.data?.data ?? []).find((s) => s.id === sessionParam)
      : (sessions.data?.data ?? []).find((s) => s.scaled_score != null);
  const results = useSessionResults(recent?.id ?? 0);
  if (sessions.isLoading || (recent && results.isLoading)) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" className="mb-4">
        <span className="sr-only">Loading recent session recap</span>
        <SkeletonCard />
      </div>
    );
  }
  if (!recent || !results.data) return null;
  return <SessionRecap results={results.data.data} summary={recent} />;
}

/**
 * LSAT-6 — the Annotations tab: the existing local annotations hub plus a
 * Notebook KB search (FTS over note text + user explanations, backend-backed,
 * best-effort) and an inline explanation editor for the selected question. The
 * search degrades to nothing when the backend is offline; the hub below is
 * always shown from localStorage.
 */
function AnnotationsTab() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AnnotationSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AnnotationSearchHit | null>(null);

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const term = query.trim();
    if (!term) {
      setHits([]);
      return;
    }
    setSearching(true);
    setHits(await searchAnnotationsKb(term, 25));
    setSearching(false);
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <form onSubmit={runSearch} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your notes &amp; explanations…"
              aria-label="Search annotations"
              className="pl-9"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" loading={searching}>
            Search
          </Button>
        </form>
        {hits.length > 0 && (
          <ul className="space-y-1.5">
            {hits.map((h) => (
              <li key={h.annotation_id}>
                <button
                  type="button"
                  onClick={() => setSelected(h)}
                  className="w-full rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-xs text-muted-foreground">{h.target}</span>
                  <p className="line-clamp-2">{h.snippet || h.user_explanation}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <AnnotationInlineEditor
            key={selected.annotation_id}
            questionId={selected.ref_id}
            annotationId={selected.annotation_id}
          />
        )}
      </section>
      <AnnotationsHub />
    </div>
  );
}
