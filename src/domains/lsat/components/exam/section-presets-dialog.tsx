import { Clock, Eye, Flag } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@lsat/components/ui/dialog";
import { formatClock } from "@lsat/lib/utils";

export type SectionPreset = "timed" | "untimed" | "br_flagged";

export function SectionPresetsDialog({
  open,
  timeLimitSec,
  hasPriorSession,
  onSelect,
}: {
  open: boolean;
  timeLimitSec: number;
  hasPriorSession: boolean;
  onSelect: (preset: SectionPreset) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>How do you want to run this section?</DialogTitle>
          <DialogDescription>
            Pick a mode before the clock starts. You can change approach on the next section.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-1 px-4 py-3 text-left"
            onClick={() => onSelect("timed")}
          >
            <span className="flex items-center gap-2 font-medium">
              <Clock className="h-4 w-4" />
              Timed ({formatClock(timeLimitSec)})
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              Exam conditions — blind review after you finish.
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-1 px-4 py-3 text-left"
            onClick={() => onSelect("untimed")}
          >
            <span className="flex items-center gap-2 font-medium">
              <Eye className="h-4 w-4" />
              Untimed review
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              No auto-submit when time expires; pace yourself.
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-1 px-4 py-3 text-left"
            disabled={!hasPriorSession}
            onClick={() => onSelect("br_flagged")}
          >
            <span className="flex items-center gap-2 font-medium">
              <Flag className="h-4 w-4" />
              Blind review (flagged only)
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {hasPriorSession
                ? "Jump to blind review for your last timed session."
                : "Finish a timed section first to unlock this preset."}
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
