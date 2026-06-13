import { useMemo, useState } from "react";
import { Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { qTypeLabel } from "@/lib/labels";
import { pluralize } from "@/lib/utils";
import type { BrowseQuestion } from "@/lib/bankBrowse";
import type { QType } from "@/lib/types";

const LR_TYPES = [
  "MainPoint", "NecessaryAssumption", "SufficientAssumption", "Strengthen",
  "Weaken", "Flaw", "Inference", "MostStronglySupported", "PrincipleApply",
  "PrincipleIdentify", "Parallel", "ParallelFlaw", "Method", "Role",
  "PointAtIssue", "Paradox", "Evaluate",
] as const;

const RC_TYPES = [
  "MainPoint", "Attitude", "Detail", "Inference", "Function", "Structure",
  "Application", "StrengthenWeaken", "Comparative",
] as const;

/** Bulk edit q_type / difficulty on filtered bank rows with durable backend persistence. */
export function TagEditor({
  items,
  filtered,
  onUpdated,
}: {
  items: BrowseQuestion[];
  filtered: BrowseQuestion[];
  onUpdated: (next: BrowseQuestion[]) => void;
}) {
  const [qType, setQType] = useState<string>("__unchanged__");
  const [difficulty, setDifficulty] = useState<string>("__unchanged__");
  const [busy, setBusy] = useState(false);

  const types = useMemo(() => {
    const fromData = new Set(items.map((i) => String(i.q_type)));
    for (const t of [...LR_TYPES, ...RC_TYPES]) fromData.add(t);
    return [...fromData].sort();
  }, [items]);

  async function applyBulk() {
    const nextType = qType !== "__unchanged__" ? qType : "";
    const nextDiff = difficulty !== "__unchanged__" ? difficulty : "";
    if (!nextType && !nextDiff) {
      toast.error("Choose a type and/or difficulty to apply.");
      return;
    }
    if (filtered.length === 0) {
      toast.error("No questions match the current filters.");
      return;
    }
    setBusy(true);
    const ids = new Set(filtered.map((q) => q.id));
    const patch = {
      ...(nextType ? { q_type: nextType as QType } : {}),
      ...(nextDiff ? { difficulty: Number(nextDiff) } : {}),
    };

    try {
      const res = await api.bankBulkTag({
        question_ids: [...ids],
        ...patch,
      });
      const next = items.map((q) =>
        ids.has(q.id) ? { ...q, ...patch } : q,
      );
      onUpdated(next);
      if (res.updated > 0) {
        toast.success(
          `Updated ${res.updated} ${pluralize(res.updated, "question")} on the server.`,
        );
      } else {
        toast.success("No saved changes — the filtered questions already had those tags.");
      }
    } catch {
      toast.error("Could not save tags — no local-only edits were applied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Tags className="h-4 w-4 text-primary" />
        <CardTitle className="text-base">Bulk tag editor</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Applies to {filtered.length} filtered{" "}
          {pluralize(filtered.length, "question")}. Changes are saved to the
          local database and written to the content audit log.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Question type</Label>
            <Select value={qType} onValueChange={setQType}>
              <SelectTrigger>
                <SelectValue placeholder="Leave unchanged" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unchanged__">Leave unchanged</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {qTypeLabel(t as QType)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Difficulty</Label>
            <Select value={difficulty} onValueChange={setDifficulty}>
              <SelectTrigger>
                <SelectValue placeholder="Leave unchanged" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unchanged__">Leave unchanged</SelectItem>
                {[1, 2, 3, 4, 5].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}★
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={() => void applyBulk()} loading={busy} className="gap-2">
          {!busy && <Tags className="h-4 w-4" />}
          Apply to filtered
        </Button>
      </CardContent>
    </Card>
  );
}
