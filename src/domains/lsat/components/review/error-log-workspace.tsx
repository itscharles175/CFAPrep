import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, Sparkles, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { EmptyState, SkeletonList } from "@lsat/components/states";
import { VirtualList } from "@lsat/components/ui/virtual-list";
import { unwrap, useErrorLog } from "@lsat/lib/hooks";
import { formatDate } from "@lsat/lib/utils";
import type { ErrorLogEntry, ErrorReason } from "@lsat/lib/types";
import { ERROR_REASONS, qTypeLabel } from "@lsat/lib/labels";

export function ErrorLogWorkspace() {
  const { data, isLoading, isError, error, refetch } = unwrap(useErrorLog());
  const [searchParams] = useSearchParams();
  const reasonParam = searchParams.get("reason");
  const [filter, setFilter] = useState<ErrorReason | "all">(
    ERROR_REASONS.some((r) => r.value === reasonParam)
      ? (reasonParam as ErrorReason)
      : "all",
  );
  const [query, setQuery] = useState("");
  const qTypeFilter = searchParams.get("q_type");

  useEffect(() => {
    const q = searchParams.get("q_type");
    if (q) setQuery(q);
    const r = searchParams.get("reason");
    if (r && ERROR_REASONS.some((er) => er.value === r)) {
      setFilter(r as ErrorReason);
    }
  }, [searchParams]);

  const entries = useMemo(() => {
    const all = data ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (filter !== "all" && e.reason !== filter) return false;
      if (qTypeFilter && String(e.question.q_type) !== qTypeFilter) return false;
      if (!q) return true;
      return (
        e.note.toLowerCase().includes(q) ||
        String(e.question.q_type).toLowerCase().includes(q) ||
        (e.ai_diagnosis?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [data, filter, query, qTypeFilter]);

  if (isLoading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading error log</span>
        <SkeletonList rows={4} />
      </div>
    );
  }
  if (isError || !data)
    return (
      <EmptyState
        title="Could not load error log"
        description={String(error)}
        action={<Button onClick={() => refetch()}>Retry</Button>}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search notes, type, diagnosis…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search error log"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterChip>
        {ERROR_REASONS.map((r) => (
          <FilterChip
            key={r.value}
            active={filter === r.value}
            onClick={() => setFilter(r.value)}
          >
            {r.label}
          </FilterChip>
        ))}
      </div>
      {entries.length === 0 ? (
        <EmptyState title="No matching errors" />
      ) : (
        <VirtualList
          items={entries}
          estimateSize={168}
          getItemKey={(e) => e.id}
          maxHeight="min(70vh, 720px)"
          renderItem={(e) => <ErrorLogRow entry={e} />}
        />
      )}
    </div>
  );
}

function ErrorLogRow({ entry: e }: { entry: ErrorLogEntry }) {
  const navigate = useNavigate();
  return (
    <Card className="mb-3">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            {qTypeLabel(e.question.q_type)}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {e.reason}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {formatDate(e.created_at)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{e.note}</p>
        {e.ai_diagnosis && (
          <p className="flex items-start gap-1.5 rounded-md bg-primary/5 p-2 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            {e.ai_diagnosis}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/explanation/${e.question.id}`)}
          >
            Full explanation
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              navigate(
                `/drills?q_type=${encodeURIComponent(String(e.question.q_type))}`,
              )
            }
          >
            <Target className="h-3.5 w-3.5" />
            Drill type
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          : "rounded-full border px-3 py-1 text-xs font-medium hover:bg-accent"
      }
    >
      {children}
    </button>
  );
}
