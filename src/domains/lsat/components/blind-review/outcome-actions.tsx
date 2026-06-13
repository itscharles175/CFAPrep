import { useNavigate } from "react-router-dom";
import { Plus, Target } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { OUTCOME_META } from "@lsat/lib/labels";
import type { Outcome, QType } from "@lsat/lib/types";

/** Post-reveal routing CTAs (Wave 2). */
export function OutcomeActions({
  outcome,
  qType,
  onAddSrs,
  srsAdded,
}: {
  outcome: Outcome;
  qType: QType;
  onAddSrs: () => void;
  srsAdded: boolean;
}) {
  const navigate = useNavigate();
  const meta = OUTCOME_META[outcome];

  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      <span className="text-sm font-medium">{meta.label}</span>
      <span className="text-xs text-muted-foreground">{meta.description}</span>
      <div className="ml-auto flex gap-2">
        {(outcome === "timing_problem" || outcome === "concept_gap") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate(`/drills?q_type=${encodeURIComponent(String(qType))}`)
            }
          >
            <Icon as={Target} />
            Drill this type
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onAddSrs} disabled={srsAdded}>
          <Icon as={Plus} />
          {srsAdded ? "In SRS" : "Add to SRS"}
        </Button>
      </div>
    </div>
  );
}
