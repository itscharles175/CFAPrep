import { useState } from "react";
import { Bookmark, Link2, Trash2 } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import {
  deleteAnalyticsView,
  getSavedAnalyticsViews,
  saveAnalyticsView,
  type SavedAnalyticsView,
} from "@lsat/lib/prefs";
import { toast } from "@lsat/lib/toast";
import type { AnalyticsRange } from "./AnalyticsFilters";
import type { Source } from "./tabs";

/** B12 — encode a view as a shareable deep link (?tab&source&range&compare).
 * Values are validated when the link is opened (Analytics reads + clamps). */
function viewUrl(v: {
  tab: string;
  range: string;
  source: string;
  comparePrior: boolean;
}): string {
  const p = new URLSearchParams();
  p.set("tab", v.tab);
  p.set("source", v.source);
  p.set("range", v.range);
  if (v.comparePrior) p.set("compare", "1");
  return `${location.origin}/analytics?${p.toString()}`;
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("View link copied to clipboard");
  } catch {
    toast.error("Could not copy link");
  }
}

/** R4-E1 — save/load analytics filter presets. */
export function SavedAnalyticsViews({
  tab,
  range,
  source,
  comparePrior,
  onApply,
}: {
  tab: string;
  range: AnalyticsRange;
  source: Source;
  comparePrior: boolean;
  onApply: (v: SavedAnalyticsView) => void;
}) {
  const [views, setViews] = useState<SavedAnalyticsView[]>(() =>
    getSavedAnalyticsViews(),
  );
  const [name, setName] = useState("");

  function save() {
    if (!name.trim()) {
      toast.error("Enter a name for this view");
      return;
    }
    const view: SavedAnalyticsView = {
      id: crypto.randomUUID(),
      name: name.trim(),
      tab,
      range,
      source,
      comparePrior,
    };
    saveAnalyticsView(view);
    setViews(getSavedAnalyticsViews());
    setName("");
    toast.success("View saved");
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <Label className="text-sm font-medium">Saved views</Label>
      <div className="flex gap-2">
        <Input
          placeholder="Name this filter set…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button size="sm" variant="outline" onClick={save} title="Save view">
          <Bookmark className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          title="Copy a shareable link to the current view"
          onClick={() => copyLink(viewUrl({ tab, range, source, comparePrior }))}
        >
          <Link2 className="h-4 w-4" />
        </Button>
      </div>
      {views.length === 0 ? (
        <p className="text-xs text-muted-foreground">No saved views yet.</p>
      ) : (
        <ul className="space-y-1">
          {views.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm"
            >
              <button
                type="button"
                className="truncate text-left hover:underline"
                onClick={() => onApply(v)}
              >
                {v.name}
              </button>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Copy shareable link"
                  aria-label="Copy shareable link"
                  onClick={() => copyLink(viewUrl(v))}
                >
                  <Link2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Delete view"
                  aria-label="Delete saved view"
                  onClick={() => {
                    deleteAnalyticsView(v.id);
                    setViews(getSavedAnalyticsViews());
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
