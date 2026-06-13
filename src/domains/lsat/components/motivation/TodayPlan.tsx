import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  Minus,
  Play,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ProgressRing } from "@lsat/components/viz";
import { UtilityTradeoffChips } from "@lsat/components/motivation/utility-tradeoff-chips";
import { useSrsDue, useDashboard, useTodayPlan } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import { qTypeLabel } from "@lsat/lib/labels";
import { cn, countLabel } from "@lsat/lib/utils";
import { formatUtilityPriority, utilityTradeoffs } from "@lsat/lib/utilityTradeoffs";
import {
  getPlanBudgetMin,
  getPlanDone,
  getPlanOrder,
  setPlanBudgetMin,
  setPlanDone,
  setPlanOrder,
  todayKey,
} from "@lsat/lib/prefs";
import type { NotebookContextMeta, Recommendation, TodayPlanFeedbackBody } from "@lsat/lib/types";

interface PlanItem {
  id: string;
  label: string;
  minutes: number;
  to: string;
  taskType?: string | null;
  qType?: string | null;
  notebookContext?: NotebookContextMeta;
  utilityLabel?: string | null;
  utilityModel?: string | null;
  utilityScore?: number | null;
  targetDifficulty?: number | null;
  tradeoffs?: string[];
}

function recToRoute(rec: Recommendation): string {
  const action = rec.action;
  const qType = action.payload?.q_type;
  if (action.type === "drill") {
    return qType
      ? `/drills?q_type=${encodeURIComponent(String(qType))}`
      : "/drills";
  }
  if (action.type === "srs") return "/srs";
  return "/drills";
}

function orderItems(items: PlanItem[], order: string[]): PlanItem[] {
  if (!order.length) return items;
  const map = new Map(items.map((i) => [i.id, i]));
  const out: PlanItem[] = [];
  for (const id of order) {
    const it = map.get(id);
    if (it) {
      out.push(it);
      map.delete(id);
    }
  }
  for (const it of map.values()) out.push(it);
  return out;
}

/** R4-A7 / R9 — the adaptive plan recast as a designed daily ritual: a budget
 * arc, satisfying check affordances, and a "done for today" terminal state.
 * Reorder + minutes-budget persistence are unchanged. */
export function TodayPlan() {
  const navigate = useNavigate();
  const srs = useSrsDue();
  const dashboard = useDashboard();
  const today = useTodayPlan(); // E1 — server-driven plan
  const diag = useQuery({
    queryKey: ["diagnose-plan"],
    queryFn: () => api.diagnose(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const feedback = useMutation({
    mutationFn: (body: TodayPlanFeedbackBody) => api.todayFeedback(body),
  });

  const [done, setDone] = useState<Record<string, boolean>>({});
  const [budget, setBudget] = useState(() => getPlanBudgetMin());
  const [order, setOrder] = useState<string[]>(() => getPlanOrder());

  useEffect(() => {
    setDone(getPlanDone());
    setOrder(getPlanOrder());
    setBudget(getPlanBudgetMin());
  }, []);

  const serverTasks = today.data?.data.tasks;
  const planUtility = today.data?.data.utility;

  const baseItems = useMemo<PlanItem[]>(() => {
    const dueCount = srs.data?.data.due_count ?? 0;

    // E1 — prefer the server-driven plan; fall back to the local heuristic when
    // the backend has no plan/tasks (offline or no goal set yet).
    if (serverTasks?.length) {
      return serverTasks.map((t, i) => {
        const engineMeta = {
          taskType: t.type,
          qType: t.q_type ?? null,
          utilityLabel: formatUtilityPriority(t),
          utilityModel: t.selector_utility_model ?? t.utility_model ?? null,
          utilityScore: t.utility_score ?? null,
          targetDifficulty: t.target_difficulty ?? null,
          tradeoffs: utilityTradeoffs(t, planUtility),
        };
        if (t.type === "srs") {
          return {
            id: "srs",
            label: t.label,
            minutes: Math.max(
              5,
              Math.round(t.est_minutes ?? (t.count ?? dueCount) * 0.75),
            ),
            to: "/srs",
            notebookContext: t.notebook_context,
            ...engineMeta,
          };
        }
        if (t.type === "drill") {
          return {
            id: `drill-${String(t.q_type ?? i)}`,
            label: t.label,
            minutes: Math.max(5, Math.round(t.est_minutes ?? 15)),
            to: t.q_type
              ? `/drills?q_type=${encodeURIComponent(String(t.q_type))}`
              : "/drills",
            notebookContext: t.notebook_context,
            ...engineMeta,
          };
        }
        return {
          id: `task-${i}`,
          label: t.label,
          minutes: Math.max(5, Math.round(t.est_minutes ?? 35)),
          to: "/practice",
          notebookContext: t.notebook_context,
          ...engineMeta,
        };
      });
    }

    const out: PlanItem[] = [];
    if (dueCount > 0) {
      out.push({
        id: "srs",
        label: `${countLabel(dueCount, "SRS card")} due`,
        minutes: Math.max(5, Math.round(dueCount * 0.75)),
        to: "/srs",
      });
    }
    const rec =
      diag.data?.recommendation ?? dashboard.data?.data.coach.recommendation;
    if (rec) {
      out.push({
        id: "coach",
        label: rec.label,
        minutes: 20,
        to: recToRoute(rec),
      });
    }
    const weak = dashboard.data?.data.weakest_types ?? [];
    weak.slice(0, 2).forEach((w) => {
      out.push({
        id: `weak-${String(w.q_type)}`,
        label: `Drill: ${qTypeLabel(w.q_type)} (weak)`,
        minutes: 15,
        to: `/drills?q_type=${encodeURIComponent(String(w.q_type))}`,
      });
    });
    return out;
  }, [serverTasks, planUtility, srs.data, dashboard.data, diag.data]);

  const items = useMemo(
    () => orderItems(baseItems, order),
    [baseItems, order],
  );

  useEffect(() => {
    const ids = baseItems.map((i) => i.id);
    const merged = orderItems(baseItems, order).map((i) => i.id);
    if (merged.join() !== order.join() && order.some((id) => ids.includes(id))) {
      return;
    }
    if (ids.length && order.join() !== ids.join()) {
      setOrder(ids);
      setPlanOrder(ids);
    }
  }, [baseItems, order]);

  function toggle(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    const nextDone = !done[id];
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      setPlanDone(next);
      return next;
    });
    if (item) {
      feedback.mutate({
        task_id: item.id,
        task_type: item.taskType ?? "",
        task_label: item.label,
        action: nextDone ? "complete" : "reopen",
        client_day: todayKey(),
        minutes: item.minutes,
        q_type: item.qType ?? null,
        utility_score: item.utilityScore ?? null,
        utility_model: item.utilityModel ?? null,
        target_difficulty: item.targetDifficulty ?? null,
        tradeoffs: item.tradeoffs ?? [],
      });
    }
  }

  function move(id: string, dir: -1 | 1) {
    const idx = items.findIndex((i) => i.id === id);
    const next = idx + dir;
    if (next < 0 || next >= items.length) return;
    const ids = items.map((i) => i.id);
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    setOrder(ids);
    setPlanOrder(ids);
  }

  function adjustBudget(delta: number) {
    const v = Math.min(240, Math.max(15, budget + delta));
    setBudget(v);
    setPlanBudgetMin(v);
  }

  const remaining = items.filter((i) => !done[i.id]);
  const totalMin = remaining.reduce((s, i) => s + i.minutes, 0);
  const overBudget = totalMin > budget;
  const allDone = items.length > 0 && remaining.length === 0;
  // Arc fills with planned minutes against the budget (clamped 0..1).
  const budgetFrac = Math.min(1, totalMin / Math.max(1, budget));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <CardTitle>Today&apos;s plan</CardTitle>
        {/* Budget arc — replaces the raw minutes <Input>; stepper adjusts it. */}
        {!allDone && (
          <div className="flex items-center gap-2">
            <ProgressRing
              value={budgetFrac}
              size={56}
              strokeWidth={5}
              color={overBudget ? "hsl(var(--warning))" : "hsl(var(--primary))"}
              label={
                <span
                  className={cn(
                    "type-numeric text-sm",
                    overBudget && "text-warning",
                  )}
                >
                  {totalMin}
                </span>
              }
              sublabel={`/ ${budget}m`}
            />
            <div className="flex flex-col gap-1">
              <button
                type="button"
                aria-label="Increase minutes budget"
                onClick={() => adjustBudget(15)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon as={Plus} size="xs" />
              </button>
              <button
                type="button"
                aria-label="Decrease minutes budget"
                onClick={() => adjustBudget(-15)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon as={Minus} size="xs" />
              </button>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5">
        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            All caught up — nothing queued for today.
          </p>
        ) : allDone ? (
          // "Done for today" terminal state — the ritual completed.
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="aurora inline-flex items-center justify-center text-success">
              <Icon as={CheckCircle2} size="lg" />
            </span>
            <p className="type-display text-lg">Done for today</p>
            <p className="type-counsel max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
              Every item checked off. Rest is part of the plan — come back
              tomorrow.
            </p>
          </div>
        ) : (
          items.map((item, idx) => {
            const isDone = !!done[item.id];
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-md p-1.5 text-sm transition-colors hover:bg-accent"
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted disabled:opacity-30"
                    disabled={idx === 0}
                    aria-label="Move up"
                    onClick={() => move(item.id, -1)}
                  >
                    <Icon as={ArrowUp} size="xs" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted disabled:opacity-30"
                    disabled={idx === items.length - 1}
                    aria-label="Move down"
                    onClick={() => move(item.id, 1)}
                  >
                    <Icon as={ArrowDown} size="xs" />
                  </button>
                </div>
                {/* Satisfying circular check affordance (replaces raw checkbox). */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isDone}
                  aria-label={`Mark "${item.label}" done`}
                  onClick={() => toggle(item.id)}
                  className={cn(
                    "shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isDone ? "text-success" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon as={isDone ? CheckCircle2 : Circle} size="md" />
                </button>
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    isDone && "text-muted-foreground",
                  )}
                >
                  <span className={cn(isDone && "line-through")}>
                    {item.label}
                  </span>
                  {(item.utilityLabel || item.tradeoffs?.length || item.notebookContext?.items?.length) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <UtilityTradeoffChips
                        priority={item.utilityLabel}
                        tradeoffs={item.tradeoffs}
                        title={item.utilityModel}
                      />
                      {item.notebookContext?.items.slice(0, 2).map((ctx) => (
                        <span
                          key={`${ctx.kind}-${ctx.id}`}
                          className="inline-flex max-w-full items-center rounded border border-border/70 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground"
                          title={ctx.title}
                        >
                          Notebook · {ctx.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="type-numeric flex items-center gap-1 text-xs text-muted-foreground">
                  {item.minutes}m
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => navigate(item.to)}
                  aria-label={`Start ${item.label}`}
                >
                  <Icon as={Play} size="xs" />
                </Button>
              </div>
            );
          })
        )}
        {overBudget && remaining.length > 0 && (
          <p className="flex items-center gap-1.5 pt-2 text-xs text-warning">
            <Icon as={Sparkles} size="xs" />
            Plan exceeds your budget — check off items or raise minutes.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
