import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lsat/components/ui/dialog";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import { Switch } from "@lsat/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lsat/components/ui/select";
import { qTypeLabel } from "@lsat/lib/labels";
import {
  CRITERIA_OUTCOMES,
  EMPTY_CRITERIA,
  buildCriteria,
  criteriaToDraft,
  type CriteriaDraft,
  type WireCriteria,
} from "@lsat/lib/playlistCriteria";
import type { LrType, RcType, SectionType } from "@lsat/lib/types";

const LR_TYPES: LrType[] = [
  "MainPoint", "NecessaryAssumption", "SufficientAssumption", "Strengthen",
  "Weaken", "Flaw", "Inference", "MostStronglySupported", "PrincipleApply",
  "PrincipleIdentify", "Parallel", "ParallelFlaw", "Method", "Role",
  "PointAtIssue", "Paradox", "Evaluate",
];
const RC_TYPES: RcType[] = [
  "MainPoint", "Attitude", "Detail", "Inference", "Function", "Structure",
  "Application", "StrengthenWeaken", "Comparative",
];

export interface SmartSetBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing values when editing (name + criteria). Omitted when creating. */
  initialName?: string;
  initialCriteria?: WireCriteria | null;
  /** Called with the assembled name + wire criteria on save. */
  onSave: (name: string, criteria: WireCriteria) => void;
  saving?: boolean;
  title?: string;
}

/**
 * Shared smart-set criteria builder dialog. Used by the Playlists page (create /
 * edit) and the "Save as Smart set" affordance on Review. Emits a `name` + the
 * wire `criteria` object produced by {@link buildCriteria}.
 */
export function SmartSetBuilder({
  open,
  onOpenChange,
  initialName,
  initialCriteria,
  onSave,
  saving,
  title,
}: SmartSetBuilderProps) {
  const [name, setName] = useState(initialName ?? "");
  const [draft, setDraft] = useState<CriteriaDraft>(() =>
    initialCriteria ? criteriaToDraft(initialCriteria) : { ...EMPTY_CRITERIA },
  );

  // Re-seed when the dialog (re)opens with new props.
  useEffect(() => {
    if (open) {
      setName(initialName ?? "");
      setDraft(initialCriteria ? criteriaToDraft(initialCriteria) : { ...EMPTY_CRITERIA });
    }
  }, [open, initialName, initialCriteria]);

  const types = draft.sectionType === "RC" ? RC_TYPES : LR_TYPES;
  const set = (patch: Partial<CriteriaDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function submit() {
    const trimmed = name.trim() || "Untitled set";
    onSave(trimmed, buildCriteria(draft));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title ?? "Smart set"}</DialogTitle>
          <DialogDescription>
            A smart set re-resolves to live questions every time you play it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="smart-set-name">Name</Label>
            <Input
              id="smart-set-name"
              value={name}
              placeholder="e.g. Hard Parallel misses"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Section</Label>
              <Select
                value={draft.sectionType ?? "any"}
                onValueChange={(v) =>
                  set({ sectionType: v as SectionType | "any", qType: "any" })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any section</SelectItem>
                  <SelectItem value="LR">Logical Reasoning</SelectItem>
                  <SelectItem value="RC">Reading Comprehension</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Question type</Label>
              <Select value={draft.qType ?? "any"} onValueChange={(v) => set({ qType: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any type</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>{qTypeLabel(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select
                value={draft.source ?? "any"}
                onValueChange={(v) => set({ source: v as CriteriaDraft["source"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any source</SelectItem>
                  <SelectItem value="real">Official only</SelectItem>
                  <SelectItem value="ai">AI-generated</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Difficulty</Label>
              <Select
                value={draft.difficulty == null ? "any" : String(draft.difficulty)}
                onValueChange={(v) => set({ difficulty: v === "any" ? "any" : Number(v) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <SelectItem key={d} value={String(d)}>{"★".repeat(d)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Outcome</Label>
              <Select
                value={draft.outcome ?? "any"}
                onValueChange={(v) => set({ outcome: v as CriteriaDraft["outcome"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any outcome</SelectItem>
                  {CRITERIA_OUTCOMES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Limit</Label>
              <Select
                value={String(draft.limit ?? 20)}
                onValueChange={(v) => set({ limit: Number(v) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[10, 20, 30, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} questions</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smart-set-pt">PrepTest name contains (optional)</Label>
            <Input
              id="smart-set-pt"
              value={draft.preptestNameContains ?? ""}
              placeholder="e.g. PrepTest 90"
              onChange={(e) => set({ preptestNameContains: e.target.value })}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="smart-set-flagged" className="cursor-pointer">Flagged only</Label>
            <Switch
              id="smart-set-flagged"
              checked={!!draft.flagged}
              onCheckedChange={(c) => set({ flagged: c })}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="smart-set-incorrect" className="cursor-pointer">
              Incorrect only
            </Label>
            <Switch
              id="smart-set-incorrect"
              checked={!!draft.incorrectOnly}
              onCheckedChange={(c) => set({ incorrectOnly: c })}
            />
          </div>
        </div>

        <DialogFooter className="pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Save set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
