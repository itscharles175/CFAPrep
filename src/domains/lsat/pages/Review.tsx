import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BookOpenCheck, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/ui/Primitives';
import { ListRow } from '@/components/ui/list-row';
import { AnimatedList } from '@lsat/components/ui/animated-list';
import { EmptyState, SkeletonCard, SkeletonList } from '@lsat/components/states';
import { IllustrationSrsCaughtUp } from '@lsat/components/illustrations';
import { TypeBadge } from '@lsat/components/viz';
import { SessionRecap } from '@lsat/components/motivation';
import { BucketQueue } from '@lsat/components/review/bucket-queue';
import { FlaggedQueue } from '@lsat/components/review/flagged-queue';
import { ErrorLogWorkspace } from '@lsat/components/review/error-log-workspace';
import { ErrorPatternBanner } from '@lsat/components/review/error-pattern-banner';
import { AnnotationsHub } from '@lsat/components/review/annotations-hub';
import { AnnotationInlineEditor } from '@lsat/components/review/annotation-inline-editor';
import { searchAnnotationsKb } from '@lsat/lib/annotationsHub';
import type { AnnotationSearchHit } from '@lsat/lib/types';
import { DockedCoach } from '@lsat/components/coach/docked-coach';
import { useErrorLog, useSessionResults, useSessions, useSrsDue } from '@lsat/lib/hooks';
import { api } from '@lsat/lib/api';
import { enqueue } from '@lsat/lib/offlineQueue';
import { toast } from '@lsat/lib/toast';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import type { SrsDue } from '@lsat/lib/types';
import { SampleDataRecovery } from '@lsat/components/sample-data-recovery';
import './review-page.css';

/** R4-B5 — unified review inbox. */
export default function Review() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'buckets';
  const navigate = useNavigate();
  const srs = useSrsDue();
  const sessions = useSessions();
  const errorLog = useErrorLog();
  const srsIsSample = srs.data?.usingSample ?? false;
  const sessionsAreSample = sessions.data?.usingSample ?? false;
  const errorLogIsSample = errorLog.data?.usingSample ?? false;
  const hasRealSessionHistory = !sessionsAreSample && Boolean(sessions.data?.data?.length);
  const due = srsIsSample ? 0 : (srs.data?.data.due_count ?? 0);

  return (
    // K4-8 — host chrome bridge: the LSAT `PageLayout` wrapper is swapped for the
    // host `PageHeader` (StatusBadge eyebrow + title + subtitle + ActionBar) so
    // the page reads in the host design system. The page keeps its own centered,
    // width-constrained content column (the LSAT shell's `<main>` supplies the
    // outer padding) — `PageHeader` is header-only, so the container lives here.
    <div className="lsat-review-page mx-auto max-w-5xl space-y-[calc(var(--space-unit)*4)]">
      <PageHeader
        eyebrow="CLOSE THE LOOP"
        title="Review"
        subtitle="Blind-review buckets, error log, and SRS — close the loop after timed work."
        actions={
          hasRealSessionHistory ? (
            <Button variant="outline" size="sm" onClick={() => navigate('/review/history')}>
              Session history
            </Button>
          ) : undefined
        }
      />
      <ErrorPatternBanner />
      {!sessionsAreSample && <RecentSessionRecap />}
      <section
        aria-labelledby="review-remediation-title"
        className="grid gap-5 rounded-[var(--radius-lg)] border border-border/80 bg-card p-5 shadow-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
        <div className="max-w-2xl space-y-1.5">
          <p className="type-overline text-primary">REMEDIATION LOOP</p>
          <h2 id="review-remediation-title" className="type-display text-xl">
            Turn a timed miss into a deliberate next step.
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Keep the boundary clear: finish your timed work, complete blind review without the answer, then use this
            queue to diagnose and schedule the repair.
          </p>
        </div>
        <ol className="grid grid-cols-3 gap-2 text-xs text-muted-foreground md:w-[20rem]">
          {['1. Timed work', '2. Blind review', '3. Repair + retain'].map((step, index) => (
            <li key={step} className="rounded-md border bg-muted/40 px-2.5 py-2 font-medium leading-4 text-foreground">
              <span className="block text-[10px] font-semibold tracking-[0.12em] text-primary">
                {index === 0 ? 'CAPTURE' : index === 1 ? 'REASON' : 'SCHEDULE'}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </section>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <p className="type-overline text-muted-foreground">REVIEW WORKSPACE</p>
            <p className="text-sm text-muted-foreground">Choose the queue that best describes the next action.</p>
          </div>
          <TabsList className="lsat-review-tabs" aria-label="Review queue">
            <TabsTrigger value="buckets">Buckets</TabsTrigger>
            <TabsTrigger value="errors">Error log</TabsTrigger>
            <TabsTrigger value="flagged">Flagged</TabsTrigger>
            <TabsTrigger value="annotations">Annotations</TabsTrigger>
            <TabsTrigger value="srs">SRS {due > 0 ? `(${due})` : ''}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="buckets" className="mt-5">
          <ReviewQueuePanel
            title="Blind-review buckets"
            description="Classify a completed attempt after blind review. This queue keeps your timed result separate from the reasoning you record afterward."
            label="START HERE AFTER A TIMED SECTION"
          >
            {sessionsAreSample ? (
              <SampleDataRecovery section="Review buckets" onRetry={() => void sessions.refetch()} />
            ) : (
              <BucketQueue />
            )}
          </ReviewQueuePanel>
        </TabsContent>
        <TabsContent value="errors" className="mt-5">
          <ReviewQueuePanel
            title="Error log"
            description="Look for the recurring diagnosis behind a miss, then open an explanation or targeted drill to repair the pattern."
            label="DIAGNOSE THE PATTERN"
          >
            {errorLogIsSample ? (
              <SampleDataRecovery section="Error log" onRetry={() => void errorLog.refetch()} />
            ) : (
              <ErrorLogWorkspace />
            )}
          </ReviewQueuePanel>
        </TabsContent>
        <TabsContent value="flagged" className="mt-5">
          <ReviewQueuePanel
            title="Flagged questions"
            description="Return to questions you marked under time pressure and decide what deserves a full explanation or a follow-up drill."
            label="FOLLOW UP ON UNCERTAINTY"
          >
            {sessionsAreSample ? (
              <SampleDataRecovery section="Flagged questions" onRetry={() => void sessions.refetch()} />
            ) : (
              <FlaggedQueue />
            )}
          </ReviewQueuePanel>
        </TabsContent>
        <TabsContent value="annotations" className="mt-5">
          <ReviewQueuePanel
            title="Annotations"
            description="Search and refine the reasoning you have already captured, so notes remain attached to the work they are meant to improve."
            label="KEEP THE RATIONALE"
          >
            <AnnotationsTab />
          </ReviewQueuePanel>
        </TabsContent>
        <TabsContent value="srs" className="mt-5">
          <ReviewQueuePanel
            title="SRS queue"
            description="Rate recall from memory. SRS is the retention step after diagnosis, not a replacement for blind review."
            label="RETAIN THE REPAIR"
          >
            {srsIsSample ? (
              <SampleDataRecovery section="SRS queue" onRetry={() => void srs.refetch()} />
            ) : (
              <SrsInlineQueue />
            )}
          </ReviewQueuePanel>
        </TabsContent>
      </Tabs>
      <DockedCoach scope="review" />
    </div>
  );
}

function ReviewQueuePanel({
  title,
  description,
  label,
  children,
}: {
  title: string;
  description: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-border/80 bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border bg-muted/30 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="type-overline text-primary">{label}</p>
          <h2 className="type-display text-lg">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        <BookOpenCheck className="hidden h-5 w-5 shrink-0 text-primary sm:block" aria-hidden="true" />
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

const SRS_RATINGS = [
  { r: 1 as const, label: 'Again' },
  { r: 2 as const, label: 'Hard' },
  { r: 3 as const, label: 'Good' },
  { r: 4 as const, label: 'Easy' },
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
    const prev = qc.getQueryData<{ data: SrsDue; usingSample: boolean }>(['srs-due']);
    // Drop the graded card and reflect one fewer due immediately.
    qc.setQueryData<{ data: SrsDue; usingSample: boolean }>(['srs-due'], (cur) =>
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
        toast.success('Review scheduled');
      })
      .catch(() => {
        // Roll the card back into the queue, then persist the grade offline.
        if (prev) qc.setQueryData(['srs-due'], prev);
        enqueue({ kind: 'srsReview', cardId, rating: r });
        toast.warning('Saved offline — review will sync when backend is back');
      })
      .finally(() => {
        void qc.invalidateQueries({ queryKey: ['srs-due'] });
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
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {SRS_RATINGS.map(({ r, label }) => (
                <Button
                  key={r}
                  size="sm"
                  variant={r >= 3 ? 'default' : 'outline'}
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
                Open <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          }
        />
      )}
    />
  );
}

function RecentSessionRecap() {
  const [params] = useSearchParams();
  const sessionParam = Number(params.get('session') || 0);
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
  const [query, setQuery] = useState('');
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
