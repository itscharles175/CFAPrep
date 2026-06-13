import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ListRow } from "@lsat/components/ui/list-row";
import { AnimatedList } from "@lsat/components/ui/animated-list";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lsat/components/ui/select";
import { BookmarkPlus } from "lucide-react";
import { IllustrationReview } from "@lsat/components/illustrations";
import { EmptyState, SkeletonList } from "@lsat/components/states";
import { SmartSetBuilder } from "@lsat/components/playlists/smart-set-builder";
import { unwrap, useSessions } from "@lsat/lib/hooks";
import { useCreatePlaylist } from "@lsat/lib/mutations";
import {
  reviewableSessions,
  useMultiSessionResults,
} from "@lsat/lib/hooks/useReviewSessions";
import { OUTCOME_META, qTypeLabel } from "@lsat/lib/labels";
import type { WireCriteria } from "@lsat/lib/playlistCriteria";
import { countLabel, formatDate, formatMs } from "@lsat/lib/utils";
import type { Outcome, ResultItem } from "@lsat/lib/types";

const OUTCOME_ORDER: Outcome[] = [
  "timing_problem",
  "concept_gap",
  "lucky",
  "timed_ok",
];

type AggregatedItem = ResultItem & { sessionId: number; sessionDate: string };

export function BucketQueue() {
  const navigate = useNavigate();
  const sessions = unwrap(useSessions());
  const list = useMemo(
    () => reviewableSessions(sessions.data ?? []),
    [sessions.data],
  );
  const [scope, setScope] = useState<"all" | "one">("all");
  const [oneId, setOneId] = useState<number | null>(list[0]?.id ?? null);
  const createPlaylist = useCreatePlaylist();
  // "Save as Smart set" — pre-seeds the builder with the bucket's outcome.
  const [saveSeed, setSaveSeed] = useState<{ name: string; criteria: WireCriteria } | null>(null);

  const activeIds = useMemo(
    () => (scope === "all" ? list.map((s) => s.id) : oneId != null ? [oneId] : []),
    [scope, list, oneId],
  );

  const { resultsBySessionId, isLoading, isError } =
    useMultiSessionResults(activeIds);

  const buckets = useMemo(() => {
    const items: AggregatedItem[] = [];
    for (const s of list) {
      if (!activeIds.includes(s.id)) continue;
      const rows = resultsBySessionId.get(s.id) ?? [];
      for (const it of rows) {
        if (it.attempt.outcome === "timed_ok") continue;
        items.push({
          ...it,
          sessionId: s.id,
          sessionDate: formatDate(s.started),
        });
      }
    }
    const map = new Map<Outcome, AggregatedItem[]>();
    for (const o of OUTCOME_ORDER) map.set(o, []);
    for (const it of items) {
      const list = map.get(it.attempt.outcome) ?? [];
      list.push(it);
      map.set(it.attempt.outcome, list);
    }
    return OUTCOME_ORDER.map((o) => ({ outcome: o, items: map.get(o) ?? [] })).filter(
      (b) => b.items.length > 0,
    );
  }, [list, activeIds, resultsBySessionId]);

  if (sessions.isLoading || isLoading) return <SkeletonList rows={4} />;
  if (isError)
    return (
      <EmptyState
        title="Could not load review queue"
        action={<Button onClick={() => sessions.refetch()}>Retry</Button>}
      />
    );

  if (!list.length || buckets.length === 0)
    return (
      <EmptyState
        illustration={<IllustrationReview />}
        title="Nothing to review"
        description="Finish timed sections and blind review to populate buckets."
        action={<Button onClick={() => navigate("/practice")}>Start practice</Button>}
      />
    );

  const latestId = list[0]?.id;

  return (
    <>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {scope === "all"
            ? `Across ${activeIds.length} recent session${activeIds.length === 1 ? "" : "s"}`
            : "Single session"}
          {latestId != null && (
            <>
              {" "}
              ·{" "}
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => navigate(`/blind-review/${latestId}`)}
              >
                Resume latest blind review
              </Button>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v as "all" | "one")}>
            <SelectTrigger className="w-36" aria-label="Queue scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All recent</SelectItem>
              <SelectItem value="one">One session</SelectItem>
            </SelectContent>
          </Select>
          {scope === "one" && (
            <Select
              value={String(oneId ?? list[0]?.id)}
              onValueChange={(v) => setOneId(Number(v))}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.type} · {formatDate(s.started)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {buckets.map(({ outcome, items }) => {
        const meta = OUTCOME_META[outcome];
        return (
          <div key={outcome}>
            <div className="mb-2 flex items-center gap-2">
              <Badge variant={meta.variant}>{meta.label}</Badge>
              <span className="text-xs text-muted-foreground">{countLabel(items.length, "question")}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() =>
                  setSaveSeed({
                    name: `${meta.label} questions`,
                    criteria: { outcome },
                  })
                }
              >
                <Icon as={BookmarkPlus} size="xs" />
                Save as Smart set
              </Button>
            </div>
            <AnimatedList
              className="space-y-2"
              items={items}
              getKey={(it) => `${it.sessionId}-${it.question.id}`}
              renderItem={(it) => (
                <ListRow
                  leading={
                    <Badge variant="secondary">
                      {qTypeLabel(it.question.q_type)}
                    </Badge>
                  }
                  title={
                    <span className="text-xs font-normal text-muted-foreground">
                      {it.sessionDate}
                    </span>
                  }
                  meta={`Timed ${it.attempt.chosen_answer ?? "—"} · ${formatMs(it.attempt.time_ms)}`}
                  trailing={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate(
                          `/explanation/${it.question.id}?attempt=${it.attempt.attempt_id}&session=${it.sessionId}`,
                        )
                      }
                    >
                      Open
                    </Button>
                  }
                />
              )}
            />
          </div>
        );
      })}
    </div>
    <SmartSetBuilder
      open={!!saveSeed}
      onOpenChange={(o) => !o && setSaveSeed(null)}
      title="Save as Smart set"
      initialName={saveSeed?.name}
      initialCriteria={saveSeed?.criteria ?? null}
      saving={createPlaylist.isPending}
      onSave={(name, criteria) =>
        createPlaylist.mutate(
          { name, kind: "smart", criteria },
          { onSuccess: () => setSaveSeed(null) },
        )
      }
    />
    </>
  );
}
