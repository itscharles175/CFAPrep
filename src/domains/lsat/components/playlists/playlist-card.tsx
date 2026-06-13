import {
  Hand,
  MoreVertical,
  Pencil,
  PlayCircle,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { qTypeLabel } from "@/lib/labels";
import { CRITERIA_OUTCOMES, type WireCriteria } from "@/lib/playlistCriteria";
import { countLabel } from "@/lib/utils";
import type { PlaylistSummary } from "@/lib/types";

/**
 * R9 (docs/19 F4.7) — a smart set rendered as a *designed collection*: a
 * cover treatment that differs for smart vs manual sets, the criteria broken
 * into individual chips (instead of one run-on summary), and a small star-rating
 * for any difficulty constraint. All derived from the existing PlaylistSummary —
 * no new data.
 */

/** Break a saved criteria object into discrete, human chips for display. */
function criteriaChips(criteria: WireCriteria | null | undefined): string[] {
  const c = criteria ?? {};
  const chips: string[] = [];
  if (typeof c.section_type === "string") chips.push(c.section_type);
  if (typeof c.q_type === "string") chips.push(qTypeLabel(c.q_type));
  if (typeof c.source === "string") {
    const src =
      c.source === "real" || c.source === "official"
        ? "Official"
        : c.source === "ai"
          ? "AI-generated"
          : String(c.source);
    chips.push(src);
  }
  const diff = c.difficulty;
  if (typeof diff === "number" || (typeof diff === "string" && diff !== "")) {
    chips.push("★".repeat(Math.max(0, Math.min(5, Number(diff)))) || "★");
  }
  if (typeof c.outcome === "string") {
    const o = CRITERIA_OUTCOMES.find((x) => x.value === c.outcome);
    chips.push(o ? o.label : String(c.outcome));
  }
  if (c.flagged === true) chips.push("Flagged");
  if (c.incorrect_only === true) chips.push("Incorrect only");
  if (
    typeof c.preptest_name_contains === "string" &&
    c.preptest_name_contains.trim()
  )
    chips.push(`PT “${c.preptest_name_contains.trim()}”`);
  if (typeof c.passage_type === "string" && c.passage_type.trim())
    chips.push(c.passage_type.trim());
  return chips;
}

export function PlaylistCard({
  playlist: p,
  playing,
  onPlay,
  onEditCriteria,
  onRename,
  onDelete,
}: {
  playlist: PlaylistSummary;
  playing: boolean;
  onPlay: () => void;
  onEditCriteria: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const isManual = p.kind === "manual";
  const chips = isManual ? [] : criteriaChips(p.criteria);
  const empty = p.count === 0;

  return (
    <Card>
      <CardContent className="flex items-stretch gap-4 py-4">
        {/* Cover treatment — smart vs manual read differently at a glance.
            Smart sets carry a verdict-accented edge + aurora glow; manual sets
            are a calm graphite tile. */}
        <div
          className={
            isManual
              ? "grid w-14 shrink-0 place-items-center rounded-card border bg-surface-2 text-muted-foreground"
              : "aurora grid w-14 shrink-0 place-items-center overflow-hidden rounded-card border border-primary/40 bg-surface-2 text-primary"
          }
          aria-hidden
        >
          <Icon as={isManual ? Hand : Sparkles} size="md" />
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-medium">{p.name}</span>
            <Badge variant={isManual ? "outline" : "secondary"}>
              {isManual ? "Manual" : "Smart"}
            </Badge>
            <Badge variant="secondary" aria-label={countLabel(p.count, "question")}>
              {countLabel(p.count, "question")}
            </Badge>
          </div>

          {isManual ? (
            <p className="text-xs text-muted-foreground">
              {empty
                ? "Empty — add questions from the bank or review"
                : "Hand-picked questions"}
            </p>
          ) : chips.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {chips.map((chip, i) => (
                <span
                  key={i}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">All questions</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={empty} loading={playing} onClick={onPlay}>
            {!playing && <Icon as={PlayCircle} size="sm" />}
            Play
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${p.name}`}
              >
                <Icon as={MoreVertical} size="sm" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!isManual && (
                <DropdownMenuItem onClick={onEditCriteria}>
                  <Icon as={Pencil} size="sm" />
                  Edit criteria
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onRename}>
                <Icon as={Pencil} size="sm" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={onDelete}
              >
                <Icon as={Trash2} size="sm" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
