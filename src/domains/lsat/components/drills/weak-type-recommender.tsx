import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { useWeakTypeSuggestions } from "@lsat/lib/hooks";
import { useCreateDrill } from "@lsat/lib/mutations";
import { qTypeLabel } from "@lsat/lib/labels";
import type { DrillConfig, SectionType, WeakTypeSuggestion } from "@lsat/lib/types";

/**
 * LSAT-7 — smart weak-type drill recommender. Pulls the ranked weakest types and
 * offers a one-click drill that carries the additive ``weak_type_remediation``
 * flag, so the backend steers selection at that type. Plays the resulting set via
 * the session runner, exactly like the Drills "Start" flow.
 */
export function WeakTypeRecommender({ limit = 3 }: { limit?: number }) {
  const navigate = useNavigate();
  const { data, isLoading } = useWeakTypeSuggestions(limit);
  const createDrill = useCreateDrill();
  const suggestions = data?.data?.suggestions ?? [];

  function start(suggestion: WeakTypeSuggestion) {
    const config: DrillConfig = {
      q_type: suggestion.drill.q_type as DrillConfig["q_type"],
      section_type: suggestion.drill.section_type as SectionType,
      count: suggestion.drill.count,
      source: "any",
      timed: suggestion.drill.timed,
      weak_type_remediation: true,
    };
    createDrill.mutate(config, {
      onSuccess: (res) => navigate(`/take/session/${res.session_id}`),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" aria-hidden />
          Weak-type drills
        </CardTitle>
        <CardDescription>
          Targeted sets on your lowest-mastery types, ranked worst-first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading weak types…</p>
        )}
        {suggestions.map((suggestion) => {
          const accuracy =
            suggestion.accuracy != null
              ? `${Math.round(suggestion.accuracy * 100)}%`
              : "—";
          return (
            <div
              key={`${suggestion.q_type}-${suggestion.section_type}`}
              className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{qTypeLabel(suggestion.q_type)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline">{suggestion.section_type}</Badge>
                  <Badge variant="warning">{accuracy} accuracy</Badge>
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => start(suggestion)}
                disabled={createDrill.isPending}
                aria-label={`Start weak-type drill for ${qTypeLabel(suggestion.q_type)}`}
              >
                {createDrill.isPending ? "Building…" : "Drill"}
              </Button>
            </div>
          );
        })}
        {!isLoading && suggestions.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Complete a few drills to surface your weakest types.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
