import { useState } from "react";
import { CheckCircle2, Tags } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import { IllustrationReview } from "@/components/illustrations";
import { ProvenanceBadge } from "@/components/bank/provenance-badge";
import { useBankTagReview } from "@/lib/hooks";
import { useBulkTag } from "@/lib/mutations";
import { qTypeLabel } from "@/lib/labels";
import { pluralize } from "@/lib/utils";
import type { QType, Question } from "@/lib/types";

// All concrete question types a human might assign during review.
const Q_TYPES: QType[] = [
  "MainPoint", "NecessaryAssumption", "SufficientAssumption", "Strengthen",
  "Weaken", "Flaw", "Inference", "MostStronglySupported", "PrincipleApply",
  "PrincipleIdentify", "Parallel", "ParallelFlaw", "Method", "Role",
  "PointAtIssue", "Paradox", "Evaluate", "Attitude", "Detail", "Function",
  "Structure", "Application", "StrengthenWeaken", "Comparative",
];

export default function BankTagReview() {
  const { data, isLoading, isError, error, refetch } = useBankTagReview(100);
  const bulkTag = useBulkTag();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<
    Record<number, { q_type?: string; difficulty?: number }>
  >({});
  const [bulkType, setBulkType] = useState<string>("");
  const [bulkDiff, setBulkDiff] = useState<string>("");

  if (isLoading) return <LoadingState label="Loading tag review queue…" />;
  if (isError || !data) return <ErrorState error={error} onRetry={refetch} />;
  const questions = data.data;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected =
    questions.length > 0 && questions.every((q) => selected.has(q.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(questions.map((q) => q.id)));

  const editOf = (q: Question) => ({
    q_type: edits[q.id]?.q_type ?? String(q.q_type),
    difficulty: edits[q.id]?.difficulty ?? q.difficulty,
  });
  const setEdit = (id: number, patch: { q_type?: string; difficulty?: number }) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const acceptRow = (q: Question) => {
    const e = editOf(q);
    bulkTag.mutate({ question_ids: [q.id], q_type: e.q_type, difficulty: e.difficulty });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(q.id);
      return next;
    });
  };

  const applyBulk = () => {
    if (selected.size === 0 || (!bulkType && !bulkDiff)) return;
    const body: { question_ids: number[]; q_type?: string; difficulty?: number } = {
      question_ids: [...selected],
    };
    if (bulkType) body.q_type = bulkType;
    if (bulkDiff) body.difficulty = Number(bulkDiff);
    bulkTag.mutate(body);
    setSelected(new Set());
    setBulkType("");
    setBulkDiff("");
  };

  return (
    <PageLayout
      title="Tag review"
      description="Confirm or correct auto-assigned types and difficulty for low-confidence items. Confirming marks them human-verified."
      width="xl"
      actions={
        data.usingSample ? (
          <Badge variant="outline" className="text-muted-foreground">
            Sample data
          </Badge>
        ) : (
          <Badge variant="secondary">{questions.length} to review</Badge>
        )
      }
    >
      {questions.length === 0 ? (
        <EmptyState
          illustration={<IllustrationReview />}
          title="Nothing to review"
          description="Every question's tags are human-confirmed or high-confidence."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border bg-surface-1 px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="type-numeric text-2xl font-semibold text-foreground">
                {questions.length}
              </span>
              <span className="text-sm text-muted-foreground">
                low-confidence {pluralize(questions.length, "item")} remaining
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Confirming a row marks its tags human-verified.
            </p>
          </div>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-surface-2 p-3 text-sm">
              <Tags className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{selected.size} selected</span>
              <Select value={bulkType} onValueChange={setBulkType}>
                <SelectTrigger className="h-8 w-44">
                  <SelectValue placeholder="Set type…" />
                </SelectTrigger>
                <SelectContent>
                  {Q_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {qTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={bulkDiff} onValueChange={setBulkDiff}>
                <SelectTrigger className="h-8 w-32">
                  <SelectValue placeholder="Difficulty…" />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {"★".repeat(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={(!bulkType && !bulkDiff) || bulkTag.isPending}
                onClick={applyBulk}
              >
                Apply to {selected.size}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="min-w-[16rem]">Question</TableHead>
                <TableHead className="w-48">Type</TableHead>
                <TableHead className="w-32">Difficulty</TableHead>
                <TableHead className="w-24 text-right">Confirm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {questions.map((q) => {
                const e = editOf(q);
                return (
                  <TableRow key={q.id} data-state={selected.has(q.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(q.id)}
                        onCheckedChange={() => toggle(q.id)}
                        aria-label={`Select question ${q.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <p className="line-clamp-2 max-w-md text-xs text-muted-foreground">
                        {q.stem || q.prompt}
                      </p>
                      <span className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
                        #{q.id}
                        <ProvenanceBadge source={String(q.source)} size="xs" />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={e.q_type}
                        onValueChange={(v) => setEdit(q.id, { q_type: v })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Q_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {qTypeLabel(t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={String(e.difficulty)}
                        onValueChange={(v) => setEdit(q.id, { difficulty: Number(v) })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5].map((d) => (
                            <SelectItem key={d} value={String(d)}>
                              {"★".repeat(d)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={bulkTag.isPending}
                        onClick={() => acceptRow(q)}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Confirm
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
