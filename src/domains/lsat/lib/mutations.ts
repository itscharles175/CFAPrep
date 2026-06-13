import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api";
import { enqueue, removeQueuedErrorLog } from "./offlineQueue";
import { toast } from "./toast";
import type {
  AiHealth,
  ChatTurn,
  DrillConfig,
  ErrorLogEntry,
  ErrorReason,
  ParsedPrepTest,
  PlaylistSummary,
  Settings,
} from "./types";

// SettingsPatch mirrors the backend `SettingsPatch` schema (api.gen.ts): the
// model/provider fields are strings, but `desired_retention` is numeric — so the
// patch body is keyed `string | number`, not `string`.
type SettingsPatch = Record<string, string | number>;

// R10 A4.2 — optimistic-update helpers.
//
// Every `withFallback` query (lib/hooks.ts) stores its payload inside an
// envelope `{ data, usingSample }`, so an optimistic cache edit must preserve
// that wrapper rather than overwriting it with a bare value. `Envelope<T>` and
// `patchEnvelope` keep the optimistic edits envelope-aware and type-safe.
type Envelope<T> = { data: T; usingSample: boolean };

/**
 * Apply `fn` to the payload inside a `withFallback` envelope, leaving the
 * `usingSample` flag intact. No-ops when the cache has not been populated yet
 * (the subsequent `onSettled` invalidation refetches the real data anyway).
 */
function patchEnvelope<T>(
  qc: ReturnType<typeof useQueryClient>,
  key: readonly unknown[],
  fn: (prev: T) => T,
): void {
  qc.setQueryData<Envelope<T>>(key, (prev) =>
    prev ? { ...prev, data: fn(prev.data) } : prev,
  );
}

/** Centralized write mutations (Round 2). */
export function useCreateDrill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: DrillConfig) => api.createDrill(config),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Drill ready");
    },
    onError: () => toast.error("Could not create drill"),
  });
}

/** API expects attempt_id per contract. */
export function useAddErrorLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      attemptId,
      reason,
      note,
    }: {
      attemptId: number;
      reason: ErrorReason;
      note: string;
    }) => api.addErrorLog(attemptId, { reason, note }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["error-log"] });
      toast.success("Logged to error journal", {
        action: {
          label: "Undo",
          onClick: () => {
            qc.setQueryData<{ data: ErrorLogEntry[]; usingSample: boolean }>(
              ["error-log"],
              (prev) => {
                if (!prev?.data?.length) return prev;
                const next = [...prev.data];
                const i = next.findIndex(
                  (e) => e.reason === vars.reason && e.note === vars.note,
                );
                if (i >= 0) next.splice(i, 1);
                else next.pop();
                return { ...prev, data: next };
              },
            );
            toast.info("Removed from list — server entry may remain until delete API exists.");
          },
        },
      });
    },
    onError: (_err, vars) => {
      enqueue({
        kind: "addErrorLog",
        attemptId: vars.attemptId,
        body: { reason: vars.reason, note: vars.note },
      });
      toast.warning("Saved offline — will sync when backend is back", {
        action: {
          label: "Undo",
          onClick: () => {
            removeQueuedErrorLog(vars.attemptId, vars.note);
            toast.info("Removed from offline queue");
          },
        },
      });
    },
  });
}

export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      parsed,
      force,
      trainingEligible,
      trainingNotes,
    }: {
      jobId: number | string;
      parsed: ParsedPrepTest;
      force?: boolean;
      trainingEligible?: boolean;
      trainingNotes?: string;
    }) =>
      api.importCommit(jobId, parsed, force ?? false, {
        training_eligible: trainingEligible || undefined,
        training_notes: trainingNotes?.trim() || undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["preptests"] });
      toast.success("PrepTest imported");
    },
    // The Import page surfaces the structured 409 integrity gate itself; only
    // toast on other (unexpected) failures so we don't double-report.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) return;
      toast.error("Import commit failed");
    },
  });
}

// --- Round 5 mutations -----------------------------------------------------
export function useRefreshCoach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.coachRefresh(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["coach"] });
      toast.success("Coach updated");
    },
    onError: () => toast.error("Could not refresh coach"),
  });
}

export function useSaveStudyPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { target_score: number; exam_date?: string | null; daily_minutes?: number }) =>
      api.saveStudyPlan(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["study-plan"] });
      void qc.invalidateQueries({ queryKey: ["today-plan"] });
      toast.success("Goal saved");
    },
    onError: () => toast.error("Could not save goal"),
  });
}

export function useDeleteErrorLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteErrorLog(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["error-log"] });
      toast.success("Entry deleted");
    },
    onError: () => toast.error("Could not delete entry"),
  });
}

export function useEditErrorLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, note }: { id: number; reason?: ErrorReason; note?: string }) =>
      api.editErrorLog(id, { reason, note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["error-log"] });
      toast.success("Entry updated");
    },
    onError: () => toast.error("Could not update entry"),
  });
}

export function useBulkSrsCards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (questionIds: number[]) => api.srsCardsBulk(questionIds),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["srs-due"] });
      toast.success(
        res.created > 0
          ? `Added ${res.created} card${res.created === 1 ? "" : "s"} to SRS`
          : "Already in your review queue",
      );
    },
    onError: () => toast.error("Could not add to SRS"),
  });
}

export function useEmbedBank() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limit: number) => api.bankEmbed(limit),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["bank-audit"] });
      toast.success(`Embedded ${res.embedded} question${res.embedded === 1 ? "" : "s"}`);
    },
    onError: () => toast.error("Embedding failed"),
  });
}

export function useBulkTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { question_ids: number[]; q_type?: string; difficulty?: number }) =>
      api.bankBulkTag(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tag-review"] });
      void qc.invalidateQueries({ queryKey: ["bank-audit"] });
      toast.success("Tags applied");
    },
    onError: () => toast.error("Could not apply tags"),
  });
}

export function useApproveQuarantine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (questionId: number) => api.genApprove(questionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["gen-quarantine"] });
      toast.success("Approved");
    },
    onError: () => toast.error("Could not approve"),
  });
}

export function useGenForType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ qType, count, activate }: { qType: string; count?: number; activate?: boolean }) =>
      api.genForType(qType, count, activate),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["gen-jobs"] });
      void qc.invalidateQueries({ queryKey: ["gen-coverage"] });
      toast[res.enqueued ? "success" : "warning"](
        res.enqueued ? "Generation queued" : (res.reason ?? "Could not queue"),
      );
    },
    onError: () => toast.error("Could not queue generation"),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    // R10 A4.2 — apply the patch to the cache instantly so the Settings card
    // (and the model-routing provider toggle) reflect the new value without
    // waiting for the refetch; snapshot/restore on error, reconcile on settle.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ["settings"] });
      await qc.cancelQueries({ queryKey: ["ai-health"] });
      const prevSettings = qc.getQueryData<Envelope<Settings>>(["settings"]);
      const prevHealth = qc.getQueryData<Envelope<AiHealth>>(["ai-health"]);

      // Overlay the patch onto the inner `settings` object (envelope-aware).
      // The patch is a loose `Record<string, string | number>`, so the merge is
      // cast back to the strict `settings` shape; the server's authoritative
      // values land on the `onSettled` refetch.
      patchEnvelope<Settings>(qc, ["settings"], (s) => ({
        ...s,
        settings: { ...s.settings, ...patch } as Settings["settings"],
      }));

      // Switching the local provider should flip the active-provider status the
      // model-routing card reads (`provider`) right away; mirror it onto
      // `local_provider` too so any dependent copy follows suit. (The wider
      // `realtime_provider` lives on the observability payload, which the
      // onSettled invalidation refetches.)
      if (typeof patch.local_provider === "string") {
        const provider = patch.local_provider;
        patchEnvelope<AiHealth>(qc, ["ai-health"], (h) => ({
          ...h,
          provider,
          local_provider: provider,
        }));
      }
      return { prevSettings, prevHealth };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.prevSettings) qc.setQueryData(["settings"], ctx.prevSettings);
      if (ctx?.prevHealth) qc.setQueryData(["ai-health"], ctx.prevHealth);
      toast.error("Could not save settings");
    },
    onSuccess: () => {
      toast.success("Settings saved");
    },
    // Keep the existing invalidations so the optimistic edit is reconciled with
    // the server's authoritative response.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["observability"] });
      void qc.invalidateQueries({ queryKey: ["ai-health"] });
    },
  });
}

export function useSaveReflection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, text, prompts }: { sessionId: number; text: string; prompts?: string[] }) =>
      api.saveReflection(sessionId, { text, prompts }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["reflection", vars.sessionId] });
      toast.success("Reflection saved");
    },
    onError: () => toast.error("Could not save reflection"),
  });
}

// X2 / D4 — local backups (Diagnostics panel)
export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.backupNow(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["backups"] });
      void qc.invalidateQueries({ queryKey: ["backup-integrity"] });
      toast.success(res.created ? `Backup created: ${res.created}` : "Backup created");
    },
    onError: () => toast.error("Could not create backup"),
  });
}

export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.backupRestore(name),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["backups"] });
      void qc.invalidateQueries({ queryKey: ["backup-integrity"] });
      if (res.restored) {
        toast.success(
          res.restart_recommended
            ? "Backup restored — restart the app to be safe"
            : "Backup restored",
          res.restart_recommended ? { duration: 8000 } : undefined,
        );
      } else {
        toast.error("Restore did not complete");
      }
    },
    onError: () => toast.error("Could not restore backup"),
  });
}

export function usePregenerate() {
  return useMutation({
    mutationFn: ({ limit, sources }: { limit?: number; sources?: string[] }) =>
      api.pregenerate(limit ?? 20, sources),
    onSuccess: (res) =>
      toast.success(`Warmed ${res.explained} explanation${res.explained === 1 ? "" : "s"}`),
    onError: () => toast.error("Could not warm cache"),
  });
}

// --- R7 6.1 — Playlists / Smart sets ---------------------------------------
// R10 A4.2 — temp id for the optimistically-inserted row; replaced by the real
// server row on the `onSettled` invalidation. Negative so it can never collide
// with a server id.
let nextOptimisticPlaylistId = -1;

export function useCreatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      kind?: string;
      criteria?: Record<string, unknown> | null;
      question_ids?: number[] | null;
    }) => api.createPlaylist(body),
    // R10 A4.2 — show the new set in the list instantly; roll back on error.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["playlists"] });
      const prev = qc.getQueryData<Envelope<PlaylistSummary[]>>(["playlists"]);
      const optimistic: PlaylistSummary = {
        id: nextOptimisticPlaylistId--,
        name: body.name,
        kind: body.kind ?? "smart",
        count: body.question_ids?.length ?? 0,
        criteria: body.criteria ?? null,
        question_ids: body.question_ids ?? null,
      };
      patchEnvelope<PlaylistSummary[]>(qc, ["playlists"], (list) => [
        optimistic,
        ...list,
      ]);
      return { prev };
    },
    onError: (_err, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(["playlists"], ctx.prev);
      toast.error("Could not save set");
    },
    onSuccess: () => {
      toast.success("Smart set saved");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["playlists"] });
    },
  });
}

export function useUpdatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      name?: string | null;
      kind?: string | null;
      criteria?: Record<string, unknown> | null;
      question_ids?: number[] | null;
    }) => api.updatePlaylist(id, body),
    // R10 A4.2 — reflect the edit in the list (and detail) instantly. Only the
    // fields actually present in the patch are overlaid; `count` is left for the
    // server to re-resolve (smart sets re-count on the backend).
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: ["playlists"] });
      await qc.cancelQueries({ queryKey: ["playlist", id] });
      const prevList = qc.getQueryData<Envelope<PlaylistSummary[]>>(["playlists"]);
      const prevDetail = qc.getQueryData(["playlist", id]);
      const overlay = (p: PlaylistSummary): PlaylistSummary => ({
        ...p,
        ...(patch.name != null ? { name: patch.name } : {}),
        ...(patch.kind != null ? { kind: patch.kind } : {}),
        ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
        ...(patch.question_ids !== undefined
          ? { question_ids: patch.question_ids }
          : {}),
      });
      patchEnvelope<PlaylistSummary[]>(qc, ["playlists"], (list) =>
        list.map((p) => (p.id === id ? overlay(p) : p)),
      );
      patchEnvelope<PlaylistSummary>(qc, ["playlist", id], overlay);
      return { prevList, prevDetail, id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(["playlists"], ctx.prevList);
      if (ctx?.prevDetail) qc.setQueryData(["playlist", ctx.id], ctx.prevDetail);
      toast.error("Could not update set");
    },
    onSuccess: () => {
      toast.success("Set updated");
    },
    onSettled: (_res, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      void qc.invalidateQueries({ queryKey: ["playlist", vars.id] });
    },
  });
}

export function useDeletePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deletePlaylist(id),
    // R10 A4.2 — drop the row instantly; restore the whole list on error.
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["playlists"] });
      const prev = qc.getQueryData<Envelope<PlaylistSummary[]>>(["playlists"]);
      patchEnvelope<PlaylistSummary[]>(qc, ["playlists"], (list) =>
        list.filter((p) => p.id !== id),
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["playlists"], ctx.prev);
      toast.error("Could not delete set");
    },
    onSuccess: () => {
      toast.success("Set deleted");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["playlists"] });
    },
  });
}

// Play resolves the set into a drill-style session; the CALLER navigates into
// the returned session (same contract as useCreateDrill) so the page controls
// the route. No cache invalidation needed.
export function usePlayPlaylist() {
  return useMutation({
    mutationFn: (id: number) => api.playPlaylist(id),
    onError: () => toast.error("Could not start this set"),
  });
}

// --- Wave 3/4 mutations ----------------------------------------------------
// X3 — coach → tutor chat. The transcript lives in component state, so this
// mutation is intentionally thin (no cache invalidation); the caller appends
// the returned reply. Errors surface a toast but are also returned to render
// inline.
export function useCoachChat() {
  return useMutation({
    mutationFn: (body: { message: string; history?: ChatTurn[] }) =>
      api.coachChat(body),
    onError: () => toast.error("Coach is offline — start the backend to chat"),
  });
}

// Q1 — rate an explanation. A 👎 (with optional note) tells the backend to
// regenerate the explanation the next time it is requested.
export function useExplainFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { question_id: number; helpful: boolean; note?: string }) =>
      api.explainFeedback(body),
    onSuccess: (res, vars) => {
      void qc.invalidateQueries({ queryKey: ["explanation-quality"] });
      if (vars.helpful) {
        toast.success("Thanks — glad it helped");
      } else if (res.will_regenerate) {
        toast.info("Noted — we'll regenerate this explanation next time");
      } else {
        toast.info("Thanks for the feedback");
      }
    },
    onError: () => toast.error("Could not send feedback"),
  });
}

// Q5 — return an approved AI item to quarantine when its live accuracy drifts.
export function useRequarantine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.requarantine(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai-drift"] });
      void qc.invalidateQueries({ queryKey: ["gen-quarantine"] });
      void qc.invalidateQueries({ queryKey: ["gen-coverage"] });
      toast.success("Returned to quarantine");
    },
    onError: () => toast.error("Could not re-quarantine"),
  });
}

// D5 — soft-delete a bank question (recoverable via restore). An optional
// `onUndo` callback lets the caller (e.g. the bank browser) re-insert the row
// into its local list when the user hits Undo, in addition to the server-side
// restore handled here.
export function useDeleteQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number; onUndo?: () => void }) =>
      api.deleteQuestion(id),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ["bank-audit"] });
      toast.success("Question deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            api
              .restoreQuestion(vars.id)
              .then(() => {
                void qc.invalidateQueries({ queryKey: ["bank-audit"] });
                vars.onUndo?.();
                toast.success("Question restored");
              })
              .catch(() => toast.error("Could not restore question"));
          },
        },
      });
    },
    onError: () => toast.error("Could not delete question"),
  });
}

// D5 — restore a soft-deleted bank question.
export function useRestoreQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.restoreQuestion(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bank-audit"] });
      toast.success("Question restored");
    },
    onError: () => toast.error("Could not restore question"),
  });
}
