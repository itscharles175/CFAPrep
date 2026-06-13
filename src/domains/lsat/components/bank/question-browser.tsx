import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FilterX, Search, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Input } from "@lsat/components/ui/input";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Checkbox } from "@lsat/components/ui/checkbox";
import { Label } from "@lsat/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lsat/components/ui/select";
import { ChoiceList } from "@lsat/components/question/choice-list";
import { Sheet, SheetContent } from "@lsat/components/ui/sheet";
import { EmptyState, ErrorState, SkeletonList } from "@lsat/components/states";
import { IllustrationPrepTests } from "@lsat/components/illustrations";
import { VirtualList } from "@lsat/components/ui/virtual-list";
import { TagEditor } from "@lsat/components/bank/tag-editor";
import {
  ProvenanceBadge,
  ProvenanceLegend,
} from "@lsat/components/bank/provenance-badge";
import { api } from "@lsat/lib/api";
import {
  loadBankQuestions,
  setBankQuestionsCache,
  type BrowseQuestion,
} from "@lsat/lib/bankBrowse";
import { qTypeLabel } from "@lsat/lib/labels";
import { useDeleteQuestion } from "@lsat/lib/mutations";
import type { QType } from "@lsat/lib/types";

/** R4-F1/F2 — filterable bank browser with preview drawer. */
export function QuestionBrowser({
  typeCounts,
}: {
  typeCounts: Record<string, number>;
}) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [items, setItems] = useState<BrowseQuestion[]>([]);
  const [qType, setQType] = useState<string>("all");
  const [difficulty, setDifficulty] = useState<string>("all");
  const [query, setQuery] = useState("");
  // Wave 1.6 — quick filter for training-flagged items so the user can audit
  // the curated subset before Wave 6 (QLoRA) consumes it.
  const [trainingOnly, setTrainingOnly] = useState(false);
  const [preview, setPreview] = useState<BrowseQuestion | null>(null);
  const deleteQuestion = useDeleteQuestion();

  function load(force = false) {
    setLoading(true);
    setLoadError(null);
    loadBankQuestions(force)
      .then((q) => setItems(q))
      .catch((e: unknown) => setLoadError(e))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  // D5 — soft-delete: optimistically drop the row, restore it on failure, and
  // re-insert it (at its original position) when the user hits Undo.
  function handleDelete(item: BrowseQuestion) {
    const index = items.findIndex((q) => q.id === item.id);
    setItems((prev) => prev.filter((q) => q.id !== item.id));
    setPreview((p) => (p?.id === item.id ? null : p));
    const reinsert = () =>
      setItems((prev) => {
        if (prev.some((q) => q.id === item.id)) return prev;
        const next = [...prev];
        next.splice(Math.max(0, index), 0, item);
        return next;
      });
    deleteQuestion.mutate(
      { id: item.id, onUndo: reinsert },
      { onError: reinsert },
    );
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (qType !== "all" && String(item.q_type) !== qType) return false;
      if (difficulty !== "all" && String(item.difficulty) !== difficulty)
        return false;
      if (trainingOnly && !item.training_eligible) return false;
      if (!q) return true;
      return (
        item.stem?.toLowerCase().includes(q) ||
        item.prompt?.toLowerCase().includes(q) ||
        String(item.q_type).toLowerCase().includes(q)
      );
    });
  }, [items, qType, difficulty, query, trainingOnly]);

  const trainingCount = useMemo(
    () => items.filter((i) => i.training_eligible).length,
    [items],
  );

  const types = Object.keys(typeCounts).sort();
  const filtersActive =
    qType !== "all" || difficulty !== "all" || trainingOnly || query.trim() !== "";

  function clearFilters() {
    setQType("all");
    setDifficulty("all");
    setTrainingOnly(false);
    setQuery("");
  }

  function handleTagsUpdated(next: BrowseQuestion[]) {
    setItems(next);
    setBankQuestionsCache(next);
  }

  if (loading) return <SkeletonList rows={6} />;
  if (loadError)
    return <ErrorState error={loadError} onRetry={() => load(true)} />;

  return (
    <div className="space-y-4">
      <TagEditor
        items={items}
        filtered={filtered}
        onUpdated={handleTagsUpdated}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browse questions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search stem or type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={qType} onValueChange={setQType}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {qTypeLabel(t as QType)} ({typeCounts[t] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Difficulty" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any diff</SelectItem>
              {[1, 2, 3, 4, 5].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d}★
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label
            htmlFor="browse-training-only"
            className={`flex items-center gap-2 rounded-md border px-3 text-xs ${
              trainingCount === 0 ? "opacity-50" : "cursor-pointer"
            }`}
          >
            <Checkbox
              id="browse-training-only"
              aria-label="Show training corpus questions only"
              checked={trainingOnly}
              onCheckedChange={(v) => setTrainingOnly(v === true)}
              disabled={trainingCount === 0}
            />
            Training corpus only ({trainingCount})
          </Label>
          <Button variant="outline" size="sm" onClick={() => load(true)}>
            Refresh
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {filtered.length} of {items.length} question
          {items.length === 1 ? "" : "s"}
          {filtersActive ? " shown" : ""}
        </p>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        items.length === 0 ? (
          <EmptyState
            illustration={<IllustrationPrepTests />}
            title="The bank is empty"
            description="Import a PrepTest or a research dataset to start filling the question bank. Imported items appear here for browsing and review."
          />
        ) : (
          <EmptyState
            icon={<FilterX className="h-6 w-6" />}
            title="No questions match these filters"
            description="Try a different type, difficulty, or search term."
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        )
      ) : (
      <VirtualList
        items={filtered}
        estimateSize={76}
        getItemKey={(item) => item.id}
        maxHeight="min(65vh, 640px)"
        className="rounded-md border"
        renderItem={(item) => (
          <div
            role="button"
            tabIndex={0}
            className="flex cursor-pointer items-center justify-between border-b p-3 last:border-b-0 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              setPreview(item);
              // Bank browse has no attempt context, so a reveal fetch 403s; keep
              // the test-mode preview already set above and swallow the failure
              // instead of leaving an unhandled rejection.
              void api
                .question(item.id, true)
                .then((full) => {
                  setPreview((p) =>
                    p?.id === item.id
                      ? { ...p, ...full, stem: full.stem, prompt: full.prompt }
                      : p,
                  );
                })
                .catch(() => {
                  /* reveal not authorized for bank browse — test-mode preview stands */
                });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setPreview(item);
              }
            }}
          >
            <div className="min-w-0 space-y-1 pr-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{qTypeLabel(item.q_type)}</Badge>
                <Badge variant="outline">{item.difficulty}★</Badge>
                <ProvenanceBadge
                  source={item.source}
                  trainingEligible={item.training_eligible}
                  trainingNotes={item.training_notes}
                  size="xs"
                />
                {item.preptestName && (
                  <span className="text-xs text-muted-foreground">
                    {item.preptestName}
                  </span>
                )}
              </div>
              <p className="truncate text-sm">{item.prompt || item.stem}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/explanation/${item.id}`);
                }}
              >
                Open
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(item);
                }}
                aria-label={`Delete question ${item.id}`}
                title="Soft-delete (recoverable)"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      />
      )}

      <ProvenanceLegend className="px-1" />

      <Sheet open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {preview && (
            <>
              <h2 className="text-lg font-semibold">Question preview</h2>
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{qTypeLabel(preview.q_type)}</Badge>
                  <Badge variant="outline">{preview.difficulty}★</Badge>
                  <ProvenanceBadge
                    source={preview.source}
                    trainingEligible={preview.training_eligible}
                    trainingNotes={preview.training_notes}
                  />
                </div>
                {preview.stem && (
                  <p className="text-sm whitespace-pre-wrap">{preview.stem}</p>
                )}
                <p className="font-medium">{preview.prompt}</p>
                <ChoiceList
                  choices={preview.choices}
                  selected={null}
                  eliminated={new Set()}
                  onSelect={() => {}}
                  onToggleEliminate={() => {}}
                  reveal={!!preview.correct_answer}
                  correctAnswer={preview.correct_answer}
                />
                <div className="flex items-center gap-2">
                  <Button onClick={() => navigate(`/explanation/${preview.id}`)}>
                    Full explanation
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(preview)}
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
