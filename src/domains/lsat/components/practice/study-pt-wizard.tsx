import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import type { PrepTestDetail } from "@/lib/types";
import { formatClock } from "@/lib/utils";

/** R4-F9 — pick sections for a timed study plan. */
export function StudyPtWizard({
  detail,
  open,
  onOpenChange,
}: {
  detail: PrepTestDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(detail.sections.map((s) => [s.id, true])),
  );

  const picked = detail.sections.filter((s) => selected[s.id]);
  const totalMin = Math.round(
    picked.reduce((sum, s) => sum + s.time_limit_sec, 0) / 60,
  );

  function startTimed() {
    const first = picked[0];
    if (!first) return;
    onOpenChange(false);
    if (picked.length === 1) {
      navigate(`/take/${first.id}`);
    } else {
      navigate(`/exam/${detail.id}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Study {detail.name}</DialogTitle>
          <DialogDescription>
            Choose sections for this session. Estimated {totalMin} minutes timed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {detail.sections.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-md border p-3"
            >
              <Switch
                checked={!!selected[s.id]}
                onCheckedChange={(v) =>
                  setSelected((prev) => ({ ...prev, [s.id]: !!v }))
                }
                aria-label={`Include ${s.type} section ${s.order}`}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{s.type}</Badge>
                  <span className="text-sm font-medium">Section {s.order}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {s.question_count} Q · {formatClock(s.time_limit_sec)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={startTimed} disabled={!picked.length}>
            Start timed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
