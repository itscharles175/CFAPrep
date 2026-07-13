import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ShieldCheck, X } from "lucide-react";
import { PageHeader } from "@/components/ui/Primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { EmptyState, ErrorState, SkeletonListPage } from "@lsat/components/states";
import { IllustrationSrsCaughtUp } from "@lsat/components/illustrations";
import { ShortcutBar } from "@lsat/components/bank/shortcut-bar";
import { ProvenanceBadge } from "@lsat/components/bank/provenance-badge";
import { ChoiceList } from "@lsat/components/question/choice-list";
import { VirtualList } from "@lsat/components/ui/virtual-list";
import { unwrap, useGenQuarantine } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import { toast } from "@lsat/lib/toast";
import { qTypeLabel } from "@lsat/lib/labels";
import { countLabel, pluralize } from "@lsat/lib/utils";
import { STORAGE_KEYS, getJSON, setJSON } from "@lsat/lib/storage";
import type { Question } from "@lsat/lib/types";

const K_DISMISSED = STORAGE_KEYS.quarantineDismissed;

function getDismissed(): Set<number> {
  const arr = getJSON<number[]>(K_DISMISSED, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

function dismiss(id: number): void {
  const s = getDismissed();
  s.add(id);
  setJSON(K_DISMISSED, [...s]);
}

export default function Quarantine() {
  const { data, usingSample, isLoading, isError, error, refetch } =
    unwrap(useGenQuarantine());
  const [busy, setBusy] = useState<number | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<number>>(() => getDismissed());

  const items = useMemo(() => {
    const all = data ?? [];
    return all.filter((q) => !dismissed.has(q.id));
  }, [data, dismissed]);

  const selectedIds = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => Number(k));

  const approve = useCallback(
    async (questionId: number) => {
      setBusy(questionId);
      try {
        await api.genApprove(questionId);
        toast.success("Question approved into the bank");
        setSelected((s) => {
          const next = { ...s };
          delete next[questionId];
          return next;
        });
        await refetch();
      } catch {
        toast.error("Approve failed — is the backend running?");
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  async function approveBatch() {
    if (!selectedIds.length) return;
    setBatchBusy(true);
    let ok = 0;
    for (const id of selectedIds) {
      try {
        await api.genApprove(id);
        ok++;
      } catch {
        /* continue */
      }
    }
    setBatchBusy(false);
    setSelected({});
    toast.success(
      `Approved ${ok} of ${countLabel(selectedIds.length, "question")}`,
    );
    await refetch();
  }

  const rejectLocal = useCallback((id: number) => {
    dismiss(id);
    setDismissed(getDismissed());
    setSelected((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
    toast.message("Dismissed from queue (local)");
  }, []);

  // L7 — keyboard triage: A approves the top card, D dismisses it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!items.length) return;
      if (e.key === "a" || e.key === "A") void approve(items[0].id);
      else if (e.key === "d" || e.key === "D") rejectLocal(items[0].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, approve, rejectLocal]);

  if (isLoading) {
    return <SkeletonListPage width="lg" cards={3} />;
  }
  if (isError) {
    return (
      <div className="page-container">
        <PageHeader title="Generation quarantine" />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Generation quarantine"
        subtitle="AI-generated questions pending review — batch approve or dismiss."
        actions={
          selectedIds.length > 0 ? (
            <Button size="sm" onClick={approveBatch} disabled={batchBusy}>
              {batchBusy ? "Approving…" : `Approve ${selectedIds.length} selected`}
            </Button>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <EmptyState
          illustration={<IllustrationSrsCaughtUp />}
          title="Quarantine empty"
          description="No pending generated questions, or the backend is offline."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border bg-surface-1 px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="type-numeric text-2xl font-semibold text-foreground">
                {items.length}
              </span>
              <span className="text-sm text-muted-foreground">
                {pluralize(items.length, "question")} remaining to review
              </span>
            </div>
            {usingSample && (
              <Badge variant="outline">Sample / offline — no live quarantine</Badge>
            )}
          </div>
          <ShortcutBar
            shortcuts={[
              { keys: ["A"], label: "approve top card" },
              { keys: ["D"], label: "dismiss top card" },
              { keys: ["Click"], label: "select for batch" },
            ]}
          />
          {/* 7.6 — virtualize: the pending-review queue can grow large after a
              big generation batch. */}
          <VirtualList
            items={items}
            estimateSize={320}
            getItemKey={(q) => q.id}
            maxHeight="min(75vh, 900px)"
            renderItem={(q) => (
              <QuarantineCard
                q={q}
                selected={!!selected[q.id]}
                onToggleSelect={() =>
                  setSelected((s) => ({ ...s, [q.id]: !s[q.id] }))
                }
                busy={busy === q.id}
                onApprove={() => approve(q.id)}
                onReject={() => rejectLocal(q.id)}
              />
            )}
          />
        </div>
      )}
    </div>
  );
}

function QuarantineCard({
  q,
  selected,
  onToggleSelect,
  busy,
  onApprove,
  onReject,
}: {
  q: Question;
  selected: boolean;
  onToggleSelect: () => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  // A11 — surface the validation verdict + suggested action (human still decides).
  const triage = useQuery({
    queryKey: ["triage", q.id],
    queryFn: () => api.quarantineTriage(q.id),
    staleTime: 60_000,
    retry: false,
  });
  const t = triage.data;
  return (
    <Card
      interactive
      className={selected ? "mb-4 ring-2 ring-primary" : "mb-4"}
      onClick={onToggleSelect}
    >
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {qTypeLabel(q.q_type)}
          <ProvenanceBadge source="ai_generated" />
        </CardTitle>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
          >
            <X className="h-4 w-4" />
            Dismiss
          </Button>
          <Button
            size="sm"
            loading={busy}
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
          >
            {!busy && <ShieldCheck className="h-4 w-4" />}
            Approve
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {t?.found && t.suggested_verdict && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                t.suggested_verdict === "approve"
                  ? "bg-success-subtle text-success"
                  : "bg-destructive-subtle text-destructive"
              }`}
            >
              <Icon
                as={t.suggested_verdict === "approve" ? CheckCircle2 : AlertTriangle}
                size="xs"
              />
              <span className="type-overline">
                Suggested: {t.suggested_verdict}
              </span>
              {t.reason ? (
                <span className="font-normal opacity-90">· {t.reason}</span>
              ) : null}
            </span>
            {Object.entries(t.checks ?? {}).map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-0.5 text-muted-foreground"
              >
                <span>{k.replace(/_/g, " ")}</span>
                <span className="font-mono tabular-nums text-foreground">
                  {String(v)}
                </span>
              </span>
            ))}
          </div>
        )}
        {q.stem && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {q.stem.slice(0, 400)}
            {q.stem.length > 400 ? "…" : ""}
          </p>
        )}
        <p className="font-medium">{q.prompt}</p>
        <ChoiceList
          choices={q.choices}
          selected={null}
          eliminated={new Set()}
          onSelect={() => {}}
          onToggleEliminate={() => {}}
          reveal={!!q.correct_answer}
          correctAnswer={q.correct_answer}
        />
      </CardContent>
    </Card>
  );
}
