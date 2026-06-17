import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListMusic, Plus } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lsat/components/ui/dialog";
import { PageLayout } from "@lsat/components/page-layout";
import { EmptyState, ErrorState, LoadingState } from "@lsat/components/states";
import { IllustrationPlaylists } from "@lsat/components/illustrations";
import { SmartSetBuilder } from "@lsat/components/playlists/smart-set-builder";
import { PlaylistCard } from "@lsat/components/playlists/playlist-card";
import { PacingBudgetCard } from "@lsat/components/drills/pacing-budget-card";
import { usePacingBudget, usePlaylists } from "@lsat/lib/hooks";
import {
  useCreatePlaylist,
  useDeletePlaylist,
  usePlayPlaylist,
  useUpdatePlaylist,
} from "@lsat/lib/mutations";
import { type WireCriteria } from "@lsat/lib/playlistCriteria";
import type { PlaylistSummary } from "@lsat/lib/types";

/**
 * R7 6.1 — custom problem sets ("Smart sets"). Lists saved playlists with their
 * live resolved count, lets the user create smart/manual sets, rename, delete,
 * and Play (which resolves the set into a drill-style session and navigates into
 * it exactly like the Drills "Start" flow).
 */
export default function Playlists() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = usePlaylists();
  const pacing = usePacingBudget("all");
  const createPlaylist = useCreatePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const playPlaylist = usePlayPlaylist();

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<PlaylistSummary | null>(null);
  const [renaming, setRenaming] = useState<PlaylistSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [deleting, setDeleting] = useState<PlaylistSummary | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);

  const playlists = data?.data ?? [];

  function play(p: PlaylistSummary) {
    setPlayingId(p.id);
    playPlaylist.mutate(p.id, {
      onSuccess: (res) => {
        setPlayingId(null);
        // Same navigation contract as the Drills "Start" flow: play the resolved
        // set via the session runner (these questions belong to no Section).
        navigate(`/take/session/${res.session_id}`);
      },
      onError: () => setPlayingId(null),
    });
  }

  function saveSmartSet(name: string, criteria: WireCriteria) {
    if (editing) {
      updatePlaylist.mutate(
        { id: editing.id, name, criteria },
        {
          onSuccess: () => {
            setBuilderOpen(false);
            setEditing(null);
          },
        },
      );
    } else {
      createPlaylist.mutate(
        { name, kind: "smart", criteria },
        { onSuccess: () => setBuilderOpen(false) },
      );
    }
  }

  function createManual() {
    const name = manualName.trim() || "Manual set";
    createPlaylist.mutate(
      { name, kind: "manual", question_ids: [] },
      {
        onSuccess: () => {
          setManualOpen(false);
          setManualName("");
        },
      },
    );
  }

  function commitRename() {
    if (!renaming) return;
    updatePlaylist.mutate(
      { id: renaming.id, name: renameValue.trim() || renaming.name },
      { onSuccess: () => setRenaming(null) },
    );
  }

  return (
    <PageLayout
      title="Smart sets"
      eyebrow="COLLECTIONS"
      icon={ListMusic}
      description="Custom problem sets that re-resolve to live questions each time you play them."
      width="lg"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setManualName("");
              setManualOpen(true);
            }}
          >
            <Icon as={Plus} size="sm" />
            Manual set
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setBuilderOpen(true);
            }}
          >
            <Icon as={Plus} size="sm" />
            New smart set
          </Button>
        </div>
      }
    >
      {(pacing.data?.data.budgets.length ?? 0) > 0 && (
        <PacingBudgetCard
          title="Per-type pacing budgets"
          budgets={pacing.data?.data.budgets ?? []}
          overBudgetCount={pacing.data?.data.over_budget_count}
          max={6}
        />
      )}
      {isLoading ? (
        <LoadingState label="Loading smart sets…" />
      ) : isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : playlists.length === 0 ? (
        <EmptyState
          illustration={<IllustrationPlaylists />}
          title="No smart sets yet"
          description="Create a smart set from criteria (type, difficulty, outcome, flagged…) or a manual set, then play it like a drill."
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setBuilderOpen(true);
              }}
            >
              <Icon as={Plus} size="sm" />
              New smart set
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {playlists.map((p) => (
            <PlaylistCard
              key={p.id}
              playlist={p}
              playing={playPlaylist.isPending && playingId === p.id}
              onPlay={() => play(p)}
              onEditCriteria={() => {
                setEditing(p);
                setBuilderOpen(true);
              }}
              onRename={() => {
                setRenaming(p);
                setRenameValue(p.name);
              }}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      )}

      {/* Smart-set create / edit */}
      <SmartSetBuilder
        open={builderOpen}
        onOpenChange={(o) => {
          setBuilderOpen(o);
          if (!o) setEditing(null);
        }}
        title={editing ? "Edit smart set" : "New smart set"}
        initialName={editing?.name}
        initialCriteria={editing?.criteria ?? null}
        onSave={saveSmartSet}
        saving={createPlaylist.isPending || updatePlaylist.isPending}
      />

      {/* Manual set */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New manual set</DialogTitle>
            <DialogDescription>
              A manual set holds hand-picked questions. Name it now and add
              questions later from the bank or review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="manual-name">Name</Label>
            <Input
              id="manual-name"
              value={manualName}
              placeholder="e.g. To revisit"
              onChange={(e) => setManualName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  createManual();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setManualOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createManual} loading={createPlaylist.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename set</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="rename-input">Name</Label>
            <Input
              id="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={commitRename} loading={updatePlaylist.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this set?</DialogTitle>
            <DialogDescription>
              "{deleting?.name}" will be removed. This does not affect the
              underlying questions.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={deletePlaylist.isPending}
              onClick={() => {
                if (!deleting) return;
                const id = deleting.id;
                deletePlaylist.mutate(id, { onSuccess: () => setDeleting(null) });
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
