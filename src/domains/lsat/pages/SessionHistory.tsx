import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { History, TrendingDown, TrendingUp } from "lucide-react";
import { PageLayout } from "@lsat/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LoadingState, EmptyState, ErrorState } from "@lsat/components/states";
import { IllustrationTimeline } from "@lsat/components/illustrations";
import { SessionComparePicker } from "@lsat/components/analytics/session-compare-picker";
import { VirtualList } from "@lsat/components/ui/virtual-list";
import { unwrap, useSessions } from "@lsat/lib/hooks";
import { getReflection } from "@lsat/lib/prefs";
import { cn, formatDate, formatDuration, pct, timeAgo } from "@lsat/lib/utils";
import type { SessionSummary } from "@lsat/lib/types";

// R11 6 — reconcile with the shared `formatDuration` (was a private minute-only
// rounder that drifted: it showed "0m" for sub-minute sessions and dropped the
// seconds the canonical formatter keeps). Guard null/zero so the dense row's
// " · {duration}" separators stay clean; otherwise defer to the shared prose
// formatter (it takes ms; `duration_sec` is seconds).
function fmtDuration(sec?: number | null): string | null {
  if (!sec || sec <= 0) return null;
  return formatDuration(sec * 1000);
}

function scoreOf(s: SessionSummary): number | null {
  return s.scaled_score ?? s.official_only_score ?? null;
}

// R11 6 — Title-Case the raw session `type` enum for the badges (was rendering
// the wire value, so "full_exam" leaked verbatim). Falls back to a humanized
// form of any unknown value.
const SESSION_TYPE_LABELS: Record<string, string> = {
  section: "Section",
  full_exam: "Full exam",
  drill: "Drill",
  review: "Review",
};

function sessionTypeLabel(type: string): string {
  const known = SESSION_TYPE_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function monthLabel(iso: string): string {
  // iso starts "YYYY-MM-DD…"; build a stable "Month YYYY" without TZ surprises.
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  if (!y || !m) return iso.slice(0, 7);
  return new Date(y, m - 1, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
}

type TimelineItem =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "session";
      key: string;
      session: SessionSummary;
      delta: number | null;
      last: boolean;
    };

/**
 * R4-B3 / R5-L3 / R9 (docs/19 F4.6) — the session history as a vertical
 * timeline: month dividers, a connecting rail with a node per session, and a
 * score delta vs the chronologically-previous scored session. Still virtualized
 * (VirtualList) so history stays cheap as it grows unbounded.
 */
export default function SessionHistory() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = unwrap(useSessions());
  const sessions = useMemo(
    () =>
      (data ?? []).filter((s) => s.ended != null || s.scaled_score != null),
    [data],
  );

  // Flatten into a virtualizable stream of month-dividers + session rows.
  // `sessions` is newest-first; the delta compares each scored session to the
  // next *older* scored session (so a rising trend reads as a green +).
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    let currentMonth = "";
    sessions.forEach((s, i) => {
      const month = s.started.slice(0, 7);
      if (month !== currentMonth) {
        currentMonth = month;
        out.push({
          kind: "divider",
          key: `m-${month}`,
          label: monthLabel(s.started),
        });
      }
      const score = scoreOf(s);
      let delta: number | null = null;
      if (score != null) {
        for (let j = i + 1; j < sessions.length; j++) {
          const prev = scoreOf(sessions[j]);
          if (prev != null) {
            delta = score - prev;
            break;
          }
        }
      }
      out.push({
        kind: "session",
        key: `s-${s.id}`,
        session: s,
        delta,
        last: i === sessions.length - 1,
      });
    });
    return out;
  }, [sessions]);

  if (isLoading) {
    return (
      <PageLayout title="Session history" eyebrow="ACTIVITY" icon={History} width="lg">
        <LoadingState label="Loading history…" />
      </PageLayout>
    );
  }

  if (isError) {
    return (
      <PageLayout title="Session history" eyebrow="ACTIVITY" icon={History} width="lg">
        <ErrorState error={error} onRetry={refetch} />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Session history"
      eyebrow="ACTIVITY"
      icon={History}
      description="Past timed sections and exams — open recap or compare any two."
      width="lg"
    >
      {sessions.length === 0 ? (
        <EmptyState
          illustration={<IllustrationTimeline />}
          title="No finished sessions yet"
          description="Take a timed section to start building your history."
          action={
            <Button onClick={() => navigate("/practice")}>Start practicing</Button>
          }
        />
      ) : (
        <>
          <SessionComparePicker sessions={sessions} />
          {/* 7.6 — virtualize: history grows unbounded as the user practices.
              Dividers + rows share one flat stream; measureElement handles the
              variable heights. */}
          <VirtualList
            items={items}
            estimateSize={76}
            getItemKey={(it) => it.key}
            maxHeight="min(70vh, 720px)"
            renderItem={(it) =>
              it.kind === "divider" ? (
                <MonthDivider label={it.label} />
              ) : (
                <TimelineRow
                  session={it.session}
                  delta={it.delta}
                  last={it.last}
                  onNavigate={navigate}
                />
              )
            }
          />
        </>
      )}
    </PageLayout>
  );
}

function MonthDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pb-2 pl-[7px] pt-4 first:pt-0">
      <span className="type-overline text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ScoreDelta({ delta }: { delta: number }) {
  if (delta === 0) {
    return <span className="text-xs tabular-nums text-muted-foreground">±0</span>;
  }
  const up = delta > 0;
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium tabular-nums",
        up ? "text-success" : "text-destructive",
      )}
    >
      <Icon as={up ? TrendingUp : TrendingDown} size="xs" />
      {up ? "+" : ""}
      {delta}
    </span>
  );
}

/**
 * R10 B3.3 — a lightweight hover/focus peek for a dense timeline row, built on
 * the shared Popover. Opens on hover-intent (delay) and on keyboard focus, never
 * on touch (so mobile taps don't fire a phantom card), and never steals focus.
 * Strictly supplementary: every value here is also reachable on the row itself
 * or via the Recap / Blind review actions, so it adds no new path-to-info.
 */
function RowPeek({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Clear any pending open/close timer on unmount (the ref is stable).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const openAfter = (ms: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(true), ms);
  };
  const closeAfter = (ms: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(false), ms);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Hover-intent: only fire for a real pointer (mouse), never touch/pen.
          onPointerEnter={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") return;
            openAfter(140);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") return;
            closeAfter(80);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="block max-w-full truncate rounded-sm text-left font-medium leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-56"
        // Don't pull focus on hover-open; keyboard users still get it via Tab.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={() => clear()}
        onPointerLeave={() => closeAfter(80)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function TimelineRow({
  session: s,
  delta,
  last,
  onNavigate,
}: {
  session: SessionSummary;
  delta: number | null;
  last: boolean;
  onNavigate: (to: string) => void;
}) {
  const refl = getReflection(s.id);
  const duration = fmtDuration(s.duration_sec);
  const score = scoreOf(s);

  const meta = (
    <>
      {s.question_count} Q
      {duration && ` · ${duration}`}
      {s.br_accuracy != null && ` · BR ${pct(s.br_accuracy)}`}
      {refl && (
        <span className="italic">
          {" · "}“{refl.slice(0, 48)}
          {refl.length > 48 ? "…" : ""}”
        </span>
      )}
    </>
  );

  const peek = (
    <RowPeek label={formatDate(s.started)}>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">{sessionTypeLabel(s.type)}</Badge>
          <span className="text-xs text-muted-foreground">{timeAgo(s.started)}</span>
        </div>
        {score != null && (
          <div className="flex items-baseline gap-2">
            <span className="stat text-2xl font-semibold tabular-nums">{score}</span>
            <span className="text-xs text-muted-foreground">scaled score</span>
            {delta != null && <ScoreDelta delta={delta} />}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Questions</dt>
          <dd className="text-right tabular-nums text-foreground">{s.question_count}</dd>
          {duration && (
            <>
              <dt>Duration</dt>
              <dd className="text-right tabular-nums text-foreground">{duration}</dd>
            </>
          )}
          {s.br_accuracy != null && (
            <>
              <dt>Blind-review</dt>
              <dd className="text-right tabular-nums text-foreground">{pct(s.br_accuracy)}</dd>
            </>
          )}
        </dl>
      </div>
    </RowPeek>
  );

  return (
    <div className="relative flex pb-2 pl-[7px]">
      {/* Connecting rail: a vertical line + a node dot per row. */}
      <span aria-hidden className="relative flex w-0 justify-center">
        {!last && <span className="absolute top-5 h-full w-px bg-border" />}
        <span className="absolute top-5 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary" />
      </span>

      <div className="ml-3 flex-1">
        <ListRow
          leading={<Badge variant="secondary">{sessionTypeLabel(s.type)}</Badge>}
          title={peek}
          meta={meta}
          trailing={
            <>
              {score != null && (
                <span className="flex items-center gap-2">
                  <span className="stat text-lg font-semibold tabular-nums">
                    {score}
                  </span>
                  {delta != null && <ScoreDelta delta={delta} />}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => onNavigate(`/review?session=${s.id}`)}
              >
                Recap
              </Button>
              <Button
                size="sm"
                onClick={() => onNavigate(`/blind-review/${s.id}`)}
              >
                Blind review
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
