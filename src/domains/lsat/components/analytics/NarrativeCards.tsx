import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import { Sparkles, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Sparkline } from "@lsat/components/viz";
import { SkeletonCard } from "@lsat/components/states";
import { api } from "@lsat/lib/api";
import { fadeUp, stagger } from "@lsat/lib/motion";
import { routeForRecommendation } from "@lsat/lib/recommendationRoutes";
import { toast } from "@lsat/lib/toast";
import type { Diagnosis } from "@lsat/lib/types";

export interface NarrativeCardsProps {
  /** Fallback coach text/recommendation from the dashboard payload. */
  fallback?: Diagnosis;
  /** Small score series to render a sparkline alongside the insight. */
  trend: number[];
  /** Deep-link within Analytics (tab + optional q_type). */
  onOpenAnalyticsTab?: (tab: string, qType?: string) => void;
}

/** §3.7 — render /api/ai/diagnose output as scannable insight cards. */
export function NarrativeCards({ fallback, trend, onOpenAnalyticsTab }: NarrativeCardsProps) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [diag, setDiag] = useState<Diagnosis | null>(fallback ?? null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      setDiag(await api.diagnose());
      toast.success("Re-analyzed your recent attempts");
    } catch {
      if (!diag) setDiag(fallback ?? null);
    } finally {
      setLoading(false);
    }
  }

  function act() {
    if (!diag) return;
    const payload = diag.recommendation.action.payload ?? {};
    const qType = payload.q_type ? String(payload.q_type) : undefined;
    if (diag.recommendation.action.type === "analytics" && onOpenAnalyticsTab) {
      onOpenAnalyticsTab(
        payload.view === "traps" ? "traps" :
        payload.view === "timing" ? "timing" :
        payload.view === "difficulty" ? "difficulty" :
        payload.view === "gap" || payload.view === "calibration" ? "gap" :
        "type",
        qType,
      );
      return;
    }
    navigate(routeForRecommendation(diag.recommendation));
  }

  return (
    <Card className="border-primary/30 bg-primary-subtle shadow-e1">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-primary" /> Diagnostic insights
        </CardTitle>
        <Button size="sm" variant="outline" onClick={run} disabled={loading}>
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {loading ? "Diagnosing…" : "Re-diagnose"}
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !diag ? (
          <SkeletonCard className="border-0 bg-transparent p-0 shadow-none" />
        ) : diag ? (
          <m.div
            variants={stagger}
            initial={reduce ? false : "hidden"}
            animate="show"
            className="grid gap-3 sm:grid-cols-2"
          >
            <m.div variants={fadeUp} className="rounded-card border bg-card p-4">
              <p className="text-sm leading-relaxed">{diag.text}</p>
              {trend.length > 1 && (
                <div className="mt-3 flex items-center gap-2">
                  <Sparkline data={trend} fill />
                  <span className="text-xs text-muted-foreground">recent scores</span>
                </div>
              )}
            </m.div>
            <m.div
              variants={fadeUp}
              className="flex flex-col justify-between rounded-card border bg-card p-4"
            >
              <div>
                <div className="type-overline text-muted-foreground">
                  Recommended action
                </div>
                <div className="mt-1 text-sm font-semibold">
                  {diag.recommendation.label}
                </div>
              </div>
              <Button size="sm" className="mt-3 self-start" onClick={act}>
                {diag.recommendation.label}
              </Button>
            </m.div>
          </m.div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Run a diagnosis to get plain-English insights on your recent attempts.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
