import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, MoreHorizontal, Play, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { AnimatedList } from "@/components/ui/animated-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboard, useSrsDue } from "@/lib/hooks";
import { api } from "@/lib/api";
import { qTypeLabel } from "@/lib/labels";
import {
  getInboxItems,
  markInboxDone,
  mergeInboxItems,
  snoozeInbox,
  type InboxItem,
} from "@/lib/recommendationInbox";
import { routeForRecommendation } from "@/lib/recommendationRoutes";

function buildItemsFromData(
  srsDue: number,
  weakTypes: { q_type: string | import("@/lib/types").QType }[],
  coachLabel?: string,
  coachRoute?: string,
): InboxItem[] {
  const items: InboxItem[] = [];
  if (srsDue > 0) {
    items.push({
      id: "srs-due",
      label: `Review ${srsDue} SRS cards`,
      to: "/srs",
      minutes: Math.min(30, srsDue * 2),
      source: "srs",
    });
  }
  const weak = weakTypes[0];
  if (weak?.q_type) {
    items.push({
      id: `weak-${weak.q_type}`,
      label: `Drill ${qTypeLabel(weak.q_type as never)}`,
      to: `/drills?q_type=${encodeURIComponent(String(weak.q_type))}`,
      minutes: 25,
      source: "weak-type",
    });
  }
  if (coachLabel && coachRoute) {
    items.push({
      id: "coach-primary",
      label: coachLabel,
      to: coachRoute,
      minutes: 35,
      source: "coach",
    });
  }
  items.push({
    id: "br-queue",
    label: "Work blind-review queue",
    to: "/review?tab=buckets",
    minutes: 20,
    source: "br",
  });
  return items;
}

/** R4-A3 — unified coach / SRS / weak-type queue with snooze & done. */
export function RecommendationInbox() {
  const navigate = useNavigate();
  const dashboard = useDashboard();
  const srs = useSrsDue();
  const [items, setItems] = useState<InboxItem[]>(() => getInboxItems());

  useEffect(() => {
    const d = dashboard.data?.data;
    if (!d) return;
    const coach = d.coach?.recommendation;
    const route = routeForRecommendation(coach);
    const merged = mergeInboxItems(
      buildItemsFromData(
        srs.data?.data.due_count ?? 0,
        d.weakest_types ?? [],
        coach?.label,
        route,
      ),
    );
    setItems(merged);
  }, [dashboard.data, srs.data]);

  useEffect(() => {
    let cancelled = false;
    api.diagnose().catch(() => null);
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, []);

  if (!items.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recommendations</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          You&apos;re caught up — start a timed section when ready.
        </CardContent>
      </Card>
    );
  }

  const totalMin = items.reduce((s, i) => s + i.minutes, 0);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Recommendations</CardTitle>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Icon as={Clock} size="xs" /> ~{totalMin} min
        </span>
      </CardHeader>
      <CardContent>
        {/* R9 F2.4 — AnimatedList so snooze/dismiss morph instead of hard-cutting. */}
        <AnimatedList
          items={items}
          getKey={(item) => item.id}
          className="space-y-2"
          renderItem={(item) => (
            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.label}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {item.source} · ~{item.minutes}m
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" onClick={() => navigate(item.to)} aria-label={`Start ${item.label}`}>
                  <Icon as={Play} size="xs" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More actions">
                      <Icon as={MoreHorizontal} size="sm" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        snoozeInbox(item.id);
                        setItems(getInboxItems().filter((i) => !i.done));
                      }}
                    >
                      Snooze 24h
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        markInboxDone(item.id);
                        setItems(getInboxItems());
                      }}
                    >
                      <X className="mr-2 h-3.5 w-3.5" /> Dismiss
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}
        />
      </CardContent>
    </Card>
  );
}
