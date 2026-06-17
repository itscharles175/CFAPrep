// Typed API client mirroring docs/05-api-contract.md.
//
// Wire shapes are sourced from the OpenAPI codegen (`api.gen.ts`, regenerated
// via `npm run gen:api` from the committed `openapi.json` snapshot). The hand-
// written `types.ts` still backs the long tail; the generated file is the source
// of truth for the hot-path shapes and must not be contradicted.
//
// 5.1 — the take → blind-review → explain loop responses are zod-validated at
// this boundary (see `apiSchemas.ts`); everything else keeps the bare cast.
import { recordExplainLatency } from "./aiMetrics";
// BB2 — unified streaming transport shared with the host (src/lib/localLlm.js).
// `@/` resolves to the host `/src` root (see vite + tsconfig.lsat aliases), so
// this reaches across the vendored-domain boundary to the one stream reader.
import { streamEvents, type SseParser } from "@/lib/streamingClient";
import type { z } from "zod";
import type { TrapPatternsMeta } from "./types-lsat2";
import {
  activityEventSchema,
  artifactVersionSchema,
  backlinkSchema,
  contentDuplicateRemediationResultSchema,
  contentHealthSchema,
  contentRevalidationRemediationResultSchema,
  contentRevalidationReportSchema,
  contentRevalidationRunResultSchema,
  contentSourceRegistrySchema,
  contentVersionSchema,
  contextPresetSchema,
  dashboardSchema,
  finishResultSchema,
  forecastSchema,
  attemptRationaleSchema,
  conceptCardsResultSchema,
  knowledgeInboxItemSchema,
  notebookChatMessageSchema,
  notebookChatSessionSchema,
  notebookChatTurnResultSchema,
  notebookNoteSchema,
  notebookSearchSchema,
  notebookSourceSchema,
  podcastEpisodeSchema,
  questionResponseSchema,
  rcDashboardSchema,
  rcPassageMapSchema,
  regressionAlertsSchema,
  sectionDetailSchema,
  sessionResultsSchema,
  scheduledTaskRunResultSchema,
  scheduledTasksSchema,
  studyArtifactSchema,
  transformationRunSchema,
  tutorConversationSchema,
  tutorTurnResultSchema,
  validateResponse,
  whyLoopSchema,
  workspaceManifestSchema,
  validatorRunSchema,
} from "./apiSchemas";
import type {
  AttemptBatchResult,
  AttemptCreateWire,
} from "./apiTypes";
import type {
  ActivityDay,
  AdaptivityPlan,
  AiHealth,
  ArtifactVersion,
  AbilityMatrix,
  BacklinkRecord,
  BackupIntegrity,
  BackupList,
  BackupRestoreResult,
  BankAudit,
  BankSource,
  BankStats,
  BlindReviewGap,
  ByTypeRow,
  ChatTurn,
  CoachSnapshot,
  Confidence,
  ContentDuplicateRemediationResult,
  ContentHealth,
  ContentRevalidationRemediationResult,
  ContentRevalidationReport,
  ContentRevalidationRunResult,
  CoverageRow,
  ActivityEvent,
  CreateAttemptBody,
  ContextMode,
  ContextPreset,
  DashboardAnalytics,
  Diagnosis,
  DifficultyRow,
  DrillConfig,
  DrillResult,
  DuplicateCluster,
  ErrorLogEntry,
  ErrorReason,
  ExamResults,
  ExamSession,
  FeedbackCohortSummary,
  FeedbackOutcomeSummary,
  FinishResult,
  Forecast,
  FocusQuality,
  GenDrift,
  GenJobSummary,
  GenQuality,
  ImportJobDetail,
  ImportJobSummary,
  ImportParseResult,
  ImportReconcileResult,
  MasteryRow,
  BenchmarkRunRecord,
  ObservabilityStatus,
  ContentSourceRegistry,
  ContentVersionFilters,
  ContentVersionRecord,
  MigrationPreview,
  KnowledgeInboxItem,
  NotebookCapabilities,
  NotebookChatMessage,
  NotebookChatSession,
  NotebookChatTurnResult,
  NotebookExportBundle,
  NotebookImportBundleResult,
  NotebookImportRequest,
  NotebookPage,
  NotebookNote,
  NotebookSearchResult,
  NotebookSource,
  ParsedPrepTest,
  PlaylistDetail,
  PlaylistPlayResult,
  PlaylistSummary,
  PrepTestDetail,
  PrepTestProgress,
  PrepTestSummary,
  QuarantineTriage,
  Question,
  RCDashboard,
  RCPassageMap,
  ReadinessStatus,
  RegressionAlerts,
  ReleaseTrustManifest,
  Reflection,
  RestoreContentVersionBody,
  RuntimeEvidence,
  SectionDetail,
  Session,
  SessionResults,
  SessionSummary,
  SessionType,
  Settings,
  SimilarQuestion,
  SourcePolicyUpdate,
  SrsDue,
  SrsReviewResult,
  StudyPlan,
  StudyArtifact,
  TimingRow,
  TodayPlan,
  TodayPlanFeedbackBody,
  TrapRow,
  TypeAnalytics,
  ScheduledTaskRecord,
  ScheduledTaskRunResult,
  PodcastEpisode,
  TransformationRun,
  ValidatorRunRecord,
  AttemptRationaleRecord,
  ConceptCardsResult,
  TutorConversation,
  TutorTurnResult,
  SocraticEvidence,
  SocraticTurnStreamDone,
  AnnotationBacklinksResult,
  AnnotationExplanation,
  AnnotationSearchHit,
  AnnotationSearchResult,
  Backlink,
  WorkspaceManifest,
  WhyLoopState,
} from "./types";
import { appendDaysQuery } from "./analyticsParams";

// StudyVault: the LSAT backend sidecar listens on 127.0.0.1:8100 (see the
// Tauri supervisor's `build_sidecar_specs` + tauri.conf CSP). It accepts
// any-origin CORS, so we hit the absolute base directly in BOTH dev (host
// Vite on :5173) and the packaged app — no Vite proxy needed. Override with
// VITE_API_BASE if the port ever changes.
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8100";

// Always absolute: the host app's origin (:5173 in dev, tauri:// in prod) is
// never the backend's origin, so a relative prefix would 404.
const PREFIX = API_BASE;

export class ApiError extends Error {
  status: number;
  /**
   * The raw `detail` payload from the error body, when present. FastAPI may
   * return a structured object (e.g. the D1 integrity gate sends
   * `{detail:{error,issues}}`); `message` holds a stringified form for display
   * while `detail` preserves the object for callers that need to inspect it.
   */
  detail?: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.status = status;
    this.name = "ApiError";
    this.detail = detail;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & {
    json?: unknown;
    /**
     * 5.1 — when provided, the JSON response is `.parse()`d against this zod
     * schema before being returned. A mismatch throws `ApiValidationError`
     * (surfaced by the ErrorBoundary) instead of an unchecked `as T` cast.
     * Reserved for the hot-path endpoints; the long tail keeps the bare cast.
     */
    validate?: z.ZodType<T>;
  },
): Promise<T> {
  const { json, headers, validate, ...rest } = init ?? {};
  const res = await fetch(`${PREFIX}${path}`, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;

  // A reachable LSAT Lab backend ALWAYS answers /api with JSON (even errors carry
  // a JSON `detail`). So a body we can't parse as JSON means we did NOT reach the
  // API at all: in dev that's the Vite proxy's gateway error / the SPA fallback
  // when the backend is down. Treat it as a connectivity failure (a `TypeError`,
  // which `withFallback` maps to "offline → sample data"), mirroring how a refused
  // connection behaves against the packaged backend — rather than mistaking a
  // proxy 500/HTML for a real backend error. Genuine backend 4xx/5xx with a JSON
  // detail still raise ApiError below (and surface, per the audit fix).
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TypeError(
      `Non-JSON response from ${path} (status ${res.status}); ` +
        "backend not reachable as an API",
    );
  }

  if (!res.ok) {
    let message = res.statusText;
    const detailPayload = (body as { detail?: unknown } | null)?.detail;
    if (typeof detailPayload === "string") {
      message = detailPayload || message;
    } else if (detailPayload && typeof detailPayload === "object") {
      // Structured detail (e.g. the D1 integrity gate). Keep a readable
      // message but preserve the object on the error for inspection.
      const obj = detailPayload as Record<string, unknown>;
      message = typeof obj.error === "string" ? obj.error : message;
    }
    throw new ApiError(message, res.status, detailPayload);
  }

  if (validate) return validateResponse(validate, body, path);
  return body as T;
}

export const api = {
  // Health
  health: () => request<{ ok: boolean }>("/api/health"),
  aiHealth: () => request<AiHealth>("/api/ai/health"),

  // PrepTests & content
  prepTests: () => request<PrepTestSummary[]>("/api/preptests"),
  prepTest: (id: number) => request<PrepTestDetail>(`/api/preptests/${id}`),
  section: (id: number) =>
    request<SectionDetail>(`/api/sections/${id}`, {
      validate: sectionDetailSchema as unknown as z.ZodType<SectionDetail>,
    }),
  // A drill / smart-set session's curated questions, section-shaped so the same
  // runner can play them (GET /sessions/{id}/questions). Assembled server-side
  // from a StudySession's persisted question_ids; `id` is the session id.
  drillSession: (sessionId: number) =>
    request<SectionDetail>(`/api/sessions/${sessionId}/questions`),
  // reveal=true gates the answer key behind proof the user already attempted the
  // question; the backend requires attempt_id or session_id for that context, so
  // callers in the review/explanation flow must forward it (else the reveal 403s).
  question: (
    id: number,
    reveal = false,
    opts?: { attemptId?: number | null; sessionId?: number | null },
  ) => {
    const params = new URLSearchParams({ reveal: String(reveal) });
    if (opts?.attemptId != null) params.set("attempt_id", String(opts.attemptId));
    if (opts?.sessionId != null) params.set("session_id", String(opts.sessionId));
    return request<Question>(`/api/questions/${id}?${params.toString()}`, {
      validate: questionResponseSchema as unknown as z.ZodType<Question>,
    });
  },
  questionSimilar: async (id: number) => {
    try {
      return await request<Question[]>(`/api/questions/${id}/similar`);
    } catch {
      try {
        return await request<Question[]>(`/api/bank/similar/${id}?k=5`);
      } catch {
        return [];
      }
    }
  },

  // Import wizard
  importParse: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportParseResult>("/api/import/parse", {
      method: "POST",
      body: form,
    });
  },
  importCommit: (
    job_id: number | string,
    parsed: ParsedPrepTest,
    force = false,
    opts?: {
      source?: string;
      training_eligible?: boolean;
      training_role?: string;
      training_notes?: string;
    },
  ) =>
    request<{ preptest_id: number }>("/api/import/commit", {
      method: "POST",
      json: { job_id, parsed, force, ...opts },
    }),
  // D1 — reconcile parsed answers against an official key (A–E, one per item).
  importReconcile: (body: {
    job_id?: number | string;
    parsed?: ParsedPrepTest;
    answer_key: string[];
    apply: boolean;
  }) =>
    request<ImportReconcileResult>("/api/import/reconcile", {
      method: "POST",
      json: body,
    }),
  listImportJobs: () => request<ImportJobSummary[]>("/api/import/jobs"),
  getImportJob: (jobId: number) =>
    request<ImportJobDetail>(`/api/import/jobs/${jobId}`),

  // Sessions & attempts
  createSession: (type: SessionType, config?: Record<string, unknown>) =>
    request<Session>("/api/sessions", {
      method: "POST",
      json: { type, config: config ?? {} },
    }),
  // 5.2 — `body` may carry a `client_attempt_id` (idempotency) and
  // `choice_events` (1.2 PoE trace). Both are optional/additive on the wire.
  createAttempt: (sessionId: number, body: CreateAttemptBody) =>
    request<{ attempt_id: number }>(`/api/sessions/${sessionId}/attempts`, {
      method: "POST",
      json: body,
    }),
  // 5.2 — write every attempt for a finished section in ONE request. Each item
  // may carry `client_attempt_id` + `choice_events`; replaying the whole batch
  // (offline retry) creates zero duplicates server-side (unique idempotency key).
  createAttemptsBatch: (sessionId: number, attempts: AttemptCreateWire[]) =>
    request<AttemptBatchResult>(`/api/sessions/${sessionId}/attempts/batch`, {
      method: "POST",
      json: { attempts },
    }),
  blindReview: (
    attemptId: number,
    body: { br_answer: string; confidence: string },
  ) =>
    request<{ ok: boolean }>(`/api/attempts/${attemptId}/blind-review`, {
      method: "PATCH",
      json: body,
    }),
  finishSession: (sessionId: number) =>
    request<FinishResult>(`/api/sessions/${sessionId}/finish`, {
      method: "POST",
      validate: finishResultSchema as unknown as z.ZodType<FinishResult>,
    }),
  sessionResults: (sessionId: number) =>
    request<SessionResults>(`/api/sessions/${sessionId}/results`, {
      validate: sessionResultsSchema as unknown as z.ZodType<SessionResults>,
    }),

  // AI
  diagnose: () =>
    request<Diagnosis>("/api/ai/diagnose", { method: "POST", json: {} }),

  // Analytics. `days` is an OPTIONAL time-window filter the backend supports on
  // every endpoint below (verified against openapi.json); omitting it means
  // all-time. `appendDaysQuery` only adds the param when a window is selected.
  dashboard: (days?: number) =>
    request<DashboardAnalytics>(appendDaysQuery("/api/analytics/dashboard", days), {
      validate: dashboardSchema as unknown as z.ZodType<DashboardAnalytics>,
    }),
  byType: (source: "official" | "all" = "all", days?: number) =>
    request<ByTypeRow[]>(
      appendDaysQuery(`/api/analytics/by-type?source=${source}`, days),
    ),
  timing: (sessionId: number) =>
    request<TimingRow[]>(`/api/analytics/timing/${sessionId}`),
  blindReviewGap: (days?: number) =>
    request<BlindReviewGap>(
      appendDaysQuery("/api/analytics/blind-review-gap", days),
    ),
  traps: (days?: number) =>
    request<TrapRow[]>(appendDaysQuery("/api/analytics/traps", days)),
  byDifficulty: (source: "official" | "all" = "all", days?: number) =>
    request<DifficultyRow[]>(
      appendDaysQuery(`/api/analytics/by-difficulty?source=${source}`, days),
    ),
  regressionAlerts: (
    source: "official" | "all" = "all",
    recentDays = 7,
    baselineDays = 30,
    minAttempts = 6,
  ) =>
    request<RegressionAlerts>(
      `/api/analytics/regressions?source=${source}&recent_days=${recentDays}&baseline_days=${baselineDays}&min_attempts=${minAttempts}`,
      {
        validate: regressionAlertsSchema as unknown as z.ZodType<RegressionAlerts>,
      },
    ),
  activity: (days = 120) =>
    request<ActivityDay[]>(`/api/analytics/activity?days=${days}`),
  feedbackCohorts: (days = 90) =>
    request<FeedbackCohortSummary>(
      appendDaysQuery("/api/analytics/feedback-cohorts", days),
    ),
  feedbackOutcomes: (
    feedbackDays = 90,
    outcomeDays = 30,
    source: "official" | "all" = "all",
    minAttempts = 3,
  ) => {
    const params = new URLSearchParams({
      feedback_days: String(feedbackDays),
      outcome_days: String(outcomeDays),
      source,
      min_attempts: String(minAttempts),
    });
    return request<FeedbackOutcomeSummary>(
      `/api/analytics/feedback-outcomes?${params.toString()}`,
    );
  },

  // Sessions (list, most-recent-first) — used by the analytics session picker.
  sessions: () => request<SessionSummary[]>("/api/sessions"),

  // SRS
  srsDue: () => request<SrsDue>("/api/srs/due"),
  srsReview: (cardId: number, rating: 1 | 2 | 3 | 4) =>
    request<SrsReviewResult>(`/api/srs/${cardId}/review`, {
      method: "POST",
      json: { rating },
    }),

  // Drills
  createDrill: (config: DrillConfig) =>
    request<DrillResult>("/api/drills", { method: "POST", json: config }),

  // vNext adaptivity/readiness/content health
  adaptivityAbility: (days = 180, persist = false) =>
    request<AbilityMatrix>(
      `/api/adaptivity/ability?days=${days}&persist=${persist ? "true" : "false"}`,
    ),
  adaptivityPlan: (minutes = 60) =>
    request<AdaptivityPlan>("/api/adaptivity/plan", {
      method: "POST",
      json: { minutes },
    }),
  readiness: (sectionType?: "LR" | "RC" | null, persist = false, days?: number | null) => {
    const params = new URLSearchParams();
    if (sectionType) params.set("section_type", sectionType);
    params.set("persist", persist ? "true" : "false");
    if (days != null) params.set("days", String(days));
    return request<ReadinessStatus>(`/api/readiness?${params}`);
  },
  contentHealth: () =>
    request<ContentHealth>("/api/content/health", {
      validate: contentHealthSchema as unknown as z.ZodType<ContentHealth>,
    }),
  contentRevalidation: (limit = 50) =>
    request<ContentRevalidationReport>(
      `/api/content/revalidation?limit=${encodeURIComponent(String(limit))}`,
      {
        validate: contentRevalidationReportSchema as unknown as z.ZodType<ContentRevalidationReport>,
      },
    ),
  runContentRevalidation: (body?: {
    limit?: number;
    force?: boolean;
    apply_quarantine?: boolean;
    model_gate?: boolean;
  }) =>
    request<ContentRevalidationRunResult>("/api/content/revalidation/run", {
      method: "POST",
      json: body ?? {},
      validate: contentRevalidationRunResultSchema as unknown as z.ZodType<ContentRevalidationRunResult>,
    }),
  remediateContentRevalidation: (
    questionId: number,
    body?: { action?: "quarantine_failed"; reason?: string },
  ) =>
    request<ContentRevalidationRemediationResult>(
      `/api/content/revalidation/${encodeURIComponent(String(questionId))}/remediate`,
      {
        method: "POST",
        json: body ?? { action: "quarantine_failed" },
        validate: contentRevalidationRemediationResultSchema as unknown as z.ZodType<ContentRevalidationRemediationResult>,
      },
    ),
  remediateContentDuplicate: (body: {
    action?: "quarantine_duplicates";
    cluster_key: string;
    canonical_question_id: number;
    expected_question_ids?: number[];
    reason?: string;
  }) =>
    request<ContentDuplicateRemediationResult>("/api/content/duplicates/remediate", {
      method: "POST",
      json: {
        action: "quarantine_duplicates",
        ...body,
      },
      validate: contentDuplicateRemediationResultSchema as unknown as z.ZodType<ContentDuplicateRemediationResult>,
    }),
  releaseTrust: (
    tier: "dev" | "release" | "packaged" = "dev",
    persist = false,
  ) =>
    request<ReleaseTrustManifest>(
      `/api/observability/trust?tier=${tier}&persist=${persist ? "true" : "false"}`,
    ),
  migrationPreview: () =>
    request<MigrationPreview>("/api/observability/migrations/dry-run"),
  scheduledTasks: () =>
    request<{ count: number; tasks: ScheduledTaskRecord[] }>(
      "/api/observability/scheduled-tasks",
      {
        validate: scheduledTasksSchema as unknown as z.ZodType<{
          count: number;
          tasks: ScheduledTaskRecord[];
        }>,
      },
    ),
  runScheduledTask: (key: string) =>
    request<ScheduledTaskRunResult>(
      `/api/observability/scheduled-tasks/${encodeURIComponent(key)}/run`,
      {
        method: "POST",
        validate: scheduledTaskRunResultSchema as unknown as z.ZodType<ScheduledTaskRunResult>,
      },
    ),
  benchmarkRuns: () =>
    request<{ count: number; runs: BenchmarkRunRecord[] }>(
      "/api/observability/benchmarks",
    ),
  runBenchmarkSmoke: () =>
    request<BenchmarkRunRecord | Record<string, unknown>>(
      "/api/observability/benchmarks/smoke",
      { method: "POST" },
    ),
  notebookPages: (q?: string) =>
    request<NotebookPage[]>(
      `/api/notebook/pages${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ),
  notebookCapabilities: () =>
    request<NotebookCapabilities>("/api/notebook-capabilities"),
  workspaceDefault: () =>
    request<WorkspaceManifest>("/api/workspaces/default", {
      validate: workspaceManifestSchema as unknown as z.ZodType<WorkspaceManifest>,
    }),
  workspaces: () =>
    request<WorkspaceManifest[]>("/api/workspaces", {
      validate: workspaceManifestSchema.array() as unknown as z.ZodType<WorkspaceManifest[]>,
    }),
  evidenceArtifact: (id: number) =>
    request<StudyArtifact>(`/api/evidence/artifacts/${id}`, {
      validate: studyArtifactSchema as unknown as z.ZodType<StudyArtifact>,
    }),
  artifactVersions: (id: number) =>
    request<ArtifactVersion[]>(`/api/evidence/artifacts/${id}/versions`, {
      validate: artifactVersionSchema.array() as unknown as z.ZodType<ArtifactVersion[]>,
    }),
  backlinks: (target: string) =>
    request<BacklinkRecord[]>(
      `/api/backlinks/${encodeURIComponent(target)}`,
      { validate: backlinkSchema.array() as unknown as z.ZodType<BacklinkRecord[]> },
    ),
  knowledgeInbox: (status?: string) =>
    request<KnowledgeInboxItem[]>(
      `/api/knowledge-inbox${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      {
        validate: knowledgeInboxItemSchema.array() as unknown as z.ZodType<KnowledgeInboxItem[]>,
      },
    ),
  updateKnowledgeInboxItem: (
    itemId: number,
    body: { status?: string; priority?: number; reason?: string },
  ) =>
    request<KnowledgeInboxItem>(`/api/knowledge-inbox/${itemId}`, {
      method: "PATCH",
      json: body,
      validate: knowledgeInboxItemSchema as unknown as z.ZodType<KnowledgeInboxItem>,
    }),
  notebookSources: () =>
    request<NotebookSource[]>("/api/notebook-sources", {
      validate: notebookSourceSchema.array(),
    }),
  importNotebookSource: (body: NotebookImportRequest) => {
    const form = new FormData();
    form.set("title", body.title);
    form.set("source_registry_key", body.source_registry_key ?? body.source_key ?? "");
    form.set("source_type", body.source_type ?? "auto");
    form.set("content_type", body.content_type ?? "");
    form.set("content", body.content ?? "");
    form.set("url", body.url ?? "");
    form.set("provider", body.provider ?? "local");
    form.set("refs", JSON.stringify(body.refs ?? []));
    form.set("tags", JSON.stringify(body.tags ?? []));
    form.set("official_firewall", body.official_firewall ? "true" : "false");
    if (body.file) form.set("file", body.file);
    return request<NotebookSource>("/api/notebook-sources/import", {
      method: "POST",
      body: form,
      validate: notebookSourceSchema,
    });
  },
  notebookNotes: () =>
    request<NotebookNote[]>("/api/notebook-notes", {
      validate: notebookNoteSchema.array(),
    }),
  createNotebookNote: (body: {
    workspace_id?: number | null;
    note_type?: string;
    title: string;
    content?: string;
    citations?: Array<string | Record<string, unknown>>;
    tags?: string[];
  }) =>
    request<NotebookNote>("/api/notebook-notes", {
      method: "POST",
      json: body,
      validate: notebookNoteSchema,
    }),
  updateNotebookNote: (
    id: number,
    body: {
      note_type?: string;
      title?: string;
      content?: string;
      citations?: Array<string | Record<string, unknown>>;
      reason?: string;
    },
  ) =>
    request<NotebookNote>(`/api/notebook-notes/${id}`, {
      method: "PATCH",
      json: body,
      validate: notebookNoteSchema,
    }),
  exportNotebook: (body: {
    title?: string;
    format?: "markdown" | "html" | "json";
    refs?: Array<string | Record<string, unknown>>;
  }) => request<NotebookExportBundle>("/api/notebook-export", { method: "POST", json: body }),
  importNotebookBundle: (body: {
    workspace_id?: number | null;
    title?: string;
    format?: "auto" | "json" | "markdown" | "html";
    content: string;
    provider?: string;
    tags?: string[];
    official_firewall?: boolean;
  }) =>
    request<NotebookImportBundleResult>("/api/notebook-import", {
      method: "POST",
      json: body,
    }),
  notebookSearch: (q: string, limit = 25) =>
    request<NotebookSearchResult>(
      `/api/notebook-search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { validate: notebookSearchSchema },
    ),
  notebookChatSessions: () =>
    request<NotebookChatSession[]>("/api/notebook-chat/sessions", {
      validate: notebookChatSessionSchema.array() as unknown as z.ZodType<NotebookChatSession[]>,
    }),
  createNotebookChatSession: (body: {
    workspace_id?: number | null;
    title?: string;
    mode?: string;
    model?: string;
    context?: Record<string, unknown>;
  }) =>
    request<NotebookChatSession>("/api/notebook-chat/sessions", {
      method: "POST",
      json: body,
      validate: notebookChatSessionSchema as unknown as z.ZodType<NotebookChatSession>,
    }),
  notebookChatMessages: (sessionId: number) =>
    request<NotebookChatMessage[]>(
      `/api/notebook-chat/sessions/${sessionId}/messages`,
      {
        validate: notebookChatMessageSchema.array() as unknown as z.ZodType<NotebookChatMessage[]>,
      },
    ),
  sendNotebookChatMessage: (
    sessionId: number,
    body: {
      role?: "user" | "assistant";
      content: string;
      mode?: ContextMode;
      refs?: Array<string | Record<string, unknown>>;
    },
  ) =>
    request<NotebookChatTurnResult>(
      `/api/notebook-chat/sessions/${sessionId}/messages`,
      { method: "POST", json: body, validate: notebookChatTurnResultSchema },
    ),
  transformations: () =>
    request<TransformationRun[]>("/api/transformations", {
      validate: transformationRunSchema.array() as unknown as z.ZodType<TransformationRun[]>,
    }),
  runTransformation: (body: {
    workspace_id?: number | null;
    template_key?: string;
    title?: string | null;
    prompt?: string;
    input_refs?: Array<string | Record<string, unknown>>;
    provider?: string;
    model?: string;
  }) =>
    request<TransformationRun>("/api/transformations/run", {
      method: "POST",
      json: body,
      validate: transformationRunSchema as unknown as z.ZodType<TransformationRun>,
    }),
  podcasts: () =>
    request<PodcastEpisode[]>("/api/podcasts", {
      validate: podcastEpisodeSchema.array() as unknown as z.ZodType<PodcastEpisode[]>,
    }),
  createPodcast: (body: {
    workspace_id?: number | null;
    title?: string;
    episode_type?: string;
    transcript?: string | null;
    source_refs?: Array<string | Record<string, unknown>>;
    provider?: string;
    generate_audio?: boolean;
  }) =>
    request<PodcastEpisode>("/api/podcasts", {
      method: "POST",
      json: body,
      validate: podcastEpisodeSchema as unknown as z.ZodType<PodcastEpisode>,
    }),
  podcastAudioUrl: (episodeId: number) => `${PREFIX}/api/podcasts/${episodeId}/audio`,
  activityEvents: () =>
    request<ActivityEvent[]>("/api/activity", {
      validate: activityEventSchema.array() as unknown as z.ZodType<ActivityEvent[]>,
    }),
  contextPresets: () =>
    request<ContextPreset[]>("/api/context-presets", {
      validate: contextPresetSchema.array() as unknown as z.ZodType<ContextPreset[]>,
    }),
  rcDashboard: () =>
    request<RCDashboard>("/api/rc/dashboard", {
      validate: rcDashboardSchema as unknown as z.ZodType<RCDashboard>,
    }),
  rcPassageMaps: () =>
    request<RCPassageMap[]>("/api/rc/passages", {
      validate: rcPassageMapSchema.array() as unknown as z.ZodType<RCPassageMap[]>,
    }),
  rcPassageMap: (id: number, persist = true) =>
    request<RCPassageMap>(
      `/api/rc/passages/${id}/map?persist=${persist ? "true" : "false"}`,
      { validate: rcPassageMapSchema as unknown as z.ZodType<RCPassageMap> },
    ),
  contentSources: () =>
    request<ContentSourceRegistry[]>("/api/content/sources", {
      validate: contentSourceRegistrySchema.array() as unknown as z.ZodType<ContentSourceRegistry[]>,
    }),
  upsertContentSource: (body: SourcePolicyUpdate) =>
    request<ContentSourceRegistry>("/api/content/sources", {
      method: "POST",
      json: body,
      validate: contentSourceRegistrySchema as unknown as z.ZodType<ContentSourceRegistry>,
    }),
  validatorRuns: () =>
    request<ValidatorRunRecord[]>("/api/content/validator-runs", {
      validate: validatorRunSchema.array() as unknown as z.ZodType<ValidatorRunRecord[]>,
    }),
  contentVersions: (filters?: ContentVersionFilters) => {
    const params = new URLSearchParams();
    if (filters?.entity) params.set("entity", filters.entity);
    if (filters?.entity_id) params.set("entity_id", String(filters.entity_id));
    if (filters?.reason) params.set("reason", filters.reason);
    if (filters?.reason_contains) params.set("reason_contains", filters.reason_contains);
    if (filters?.source_key) params.set("source_key", filters.source_key);
    if (filters?.risk_code) params.set("risk_code", filters.risk_code);
    if (filters?.risk_severity) params.set("risk_severity", filters.risk_severity);
    if (filters?.changed_field) params.set("changed_field", filters.changed_field);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return request<ContentVersionRecord[]>(
      `/api/content/versions${qs ? `?${qs}` : ""}`,
      { validate: contentVersionSchema.array() as unknown as z.ZodType<ContentVersionRecord[]> },
    );
  },
  restoreContentVersion: (versionId: number, body: RestoreContentVersionBody) =>
    request<ContentSourceRegistry>(`/api/content/versions/${versionId}/restore`, {
      method: "POST",
      json: body,
      validate: contentSourceRegistrySchema as unknown as z.ZodType<ContentSourceRegistry>,
    }),
  whyLoop: (attemptId: number, reveal = false) =>
    request<WhyLoopState>(
      `/api/attempts/${attemptId}/why-loop?reveal=${reveal ? "true" : "false"}`,
      { validate: whyLoopSchema as unknown as z.ZodType<WhyLoopState> },
    ),
  saveRationale: (
    attemptId: number,
    body: {
      stage?: "timed" | "blind_review" | "revision";
      answer?: string | null;
      confidence?: Confidence | null;
      rationale_text: string;
      trap_guess?: string | null;
    },
  ) =>
    request<AttemptRationaleRecord>(`/api/attempts/${attemptId}/rationale`, {
      method: "POST",
      json: body,
      validate: attemptRationaleSchema as unknown as z.ZodType<AttemptRationaleRecord>,
    }),
  createConceptCards: (attemptId: number) =>
    request<ConceptCardsResult>(`/api/attempts/${attemptId}/concept-cards`, {
      method: "POST",
      validate: conceptCardsResultSchema as unknown as z.ZodType<ConceptCardsResult>,
    }),
  conversations: (questionId?: number) =>
    request<TutorConversation[]>(
      `/api/conversations${questionId ? `?question_id=${questionId}` : ""}`,
      { validate: tutorConversationSchema.array() as unknown as z.ZodType<TutorConversation[]> },
    ),
  createConversation: (body: {
    question_id: number;
    attempt_id?: number | null;
    title?: string | null;
    mode?: string;
  }) =>
    request<TutorConversation>("/api/conversations", {
      method: "POST",
      json: body,
      validate: tutorConversationSchema as unknown as z.ZodType<TutorConversation>,
    }),
  addTutorTurn: (
    conversationId: number,
    body: { role?: "user" | "assistant"; content: string; auto_reply?: boolean },
  ) =>
    request<TutorTurnResult>(`/api/conversations/${conversationId}/turns`, {
      method: "POST",
      json: body,
      validate: tutorTurnResultSchema as unknown as z.ZodType<TutorTurnResult>,
    }),
  // LSAT-4 — the standalone citable evidence (similar_misses + notebook_context)
  // behind a conversation's Socratic nudges (read-only).
  getConversationEvidence: (conversationId: number) =>
    request<SocraticEvidence>(`/api/conversations/${conversationId}/evidence`),
  // LSAT-4 — stream a Socratic reply for a new turn over SSE. Handler-based like
  // streamExplain; builds on the unified BB2 stream reader. The user turn +
  // assistant reply are persisted server-side before the first token, so an
  // aborted mid-stream send never loses the record.
  addTutorTurnStream: (
    conversationId: number,
    body: { role?: "user" | "assistant"; content: string; auto_reply?: boolean },
    handlers: {
      onToken: (token: string) => void;
      onDone?: (meta?: SocraticTurnStreamDone) => void;
      onError?: (err: Error) => void;
      signal?: AbortSignal;
    },
  ) => streamSocraticTurn(conversationId, body, handlers),

  // Playlists / Smart sets (R7 6.1). The response bodies are free-form on the
  // wire (the OpenAPI snapshot leaves them untyped); we cast to the hand-written
  // shapes in types.ts. `/play` mirrors POST /api/drills exactly.
  // GET /api/playlists returns a {playlists, criteria_keys} envelope — unwrap to
  // the array the callers (usePlaylists, Playlists.tsx) expect (the page maps
  // over it directly, so returning the raw object would crash the page).
  playlists: () =>
    request<{ playlists: PlaylistSummary[] }>("/api/playlists").then(
      (r) => r.playlists ?? [],
    ),
  playlist: (id: number) => request<PlaylistDetail>(`/api/playlists/${id}`),
  createPlaylist: (body: {
    name: string;
    kind?: string;
    criteria?: Record<string, unknown> | null;
    question_ids?: number[] | null;
  }) =>
    request<PlaylistSummary>("/api/playlists", {
      method: "POST",
      json: { kind: "smart", ...body },
    }),
  updatePlaylist: (
    id: number,
    body: {
      name?: string | null;
      kind?: string | null;
      criteria?: Record<string, unknown> | null;
      question_ids?: number[] | null;
    },
  ) =>
    request<PlaylistSummary>(`/api/playlists/${id}`, {
      method: "PUT",
      json: body,
    }),
  deletePlaylist: (id: number) =>
    request<{ ok: boolean }>(`/api/playlists/${id}`, { method: "DELETE" }),
  playPlaylist: (id: number) =>
    request<PlaylistPlayResult>(`/api/playlists/${id}/play`, {
      method: "POST",
      json: {},
    }),

  // Error log
  addErrorLog: (
    attemptId: number,
    body: { reason: ErrorReason; note: string },
  ) =>
    request<{ id: number }>(`/api/attempts/${attemptId}/error-log`, {
      method: "POST",
      json: body,
    }),
  errorLog: () => request<ErrorLogEntry[]>("/api/error-log"),

  // AI generation & quarantine (Tier B)
  genQuarantine: () => request<Question[]>("/api/gen/quarantine"),
  genApprove: (questionId: number) =>
    request<{ ok: boolean }>(`/api/gen/quarantine/${questionId}/approve`, {
      method: "POST",
    }),

  // Bank (research dataset import, tagging, bootstrap, stats)
  bankStats: () => request<BankStats>("/api/bank/stats"),
  bankSources: () => request<BankSource[]>("/api/bank/sources"),
  bankImport: (
    sources?: string[],
    limit?: number,
    opts?: {
      nc_acknowledged?: boolean;
      local_paths?: Record<string, string>;
      training_eligible?: boolean;
      training_role?: string;
      training_notes?: string;
    },
  ) =>
    request<{
      results: {
        dataset: string;
        preptest_id?: number;
        inserted?: number;
        skipped_duplicate?: number;
        rows_seen?: number;
        error?: string;
      }[];
    }>("/api/bank/import", {
      method: "POST",
      json: { sources, limit, ...opts },
    }),
  bankTag: (limit = 200, only_research = true) =>
    request<{
      scanned: number;
      updated: number;
      via_heuristic: number;
      via_model: number;
      via_fallback: number;
    }>("/api/bank/tag", {
      method: "POST",
      json: { limit, only_research },
    }),
  bankBootstrap: (body: {
    target_total: number;
    per_type_cap?: number;
    tag_limit?: number;
    run_generation?: boolean;
    no_import?: boolean;
  }) =>
    request<{
      starting_total: number;
      final_total_after_import_and_tag: number;
      inserted_research: number;
      tagged: number;
      job_ids: number[];
      generation_dispatched: boolean;
    }>("/api/bank/bootstrap", {
      method: "POST",
      json: body,
    }),
  bankQuestions: (params?: {
    offset?: number;
    cursor?: number;
    limit?: number;
    q_type?: string;
    q?: string;
    source?: string;
    training_eligible?: boolean;
  }) => {
    const sp = new URLSearchParams();
    if (params?.offset != null) sp.set("offset", String(params.offset));
    if (params?.cursor != null) sp.set("cursor", String(params.cursor));
    if (params?.limit != null) sp.set("limit", String(params.limit));
    if (params?.q_type) sp.set("q_type", params.q_type);
    if (params?.q) sp.set("q", params.q);
    if (params?.source) sp.set("source", params.source);
    if (params?.training_eligible) sp.set("training_eligible", "true");
    const qs = sp.toString();
    return request<{
      total: number;
      offset: number;
      limit: number;
      cursor?: number | null;
      next_cursor?: number | null;
      has_more?: boolean;
      items: {
        id: number;
        q_type: string;
        difficulty: number;
        source: string;
        stem_preview: string;
        prompt_preview: string;
        quarantined: boolean;
        approved: boolean;
        training_eligible: boolean;
        training_notes?: string | null;
      }[];
    }>(`/api/bank/questions${qs ? `?${qs}` : ""}`);
  },
  bankExport: (includeHistory = true) =>
    request<Record<string, unknown>>(
      `/api/bank/export?include_history=${includeHistory}`,
    ),
  bankImportBackup: (payload: Record<string, unknown>) =>
    request<{
      preptests: number;
      questions: number;
      questions_existing: number;
      unsectioned: number;
    }>("/api/bank/import-backup", {
      method: "POST",
      json: { payload },
    }),
  bankBulkTag: async (body: {
    question_ids: number[];
    q_type?: string;
    difficulty?: number;
  }) =>
    request<{
      updated: number;
      requested?: number;
      missing?: number;
      unchanged?: number;
    }>("/api/bank/bulk-tag", {
      method: "POST",
      json: body,
    }),

  listAnnotations: async (questionId: number, attemptId?: number) => {
    const paths = attemptId
      ? [`/api/attempts/${attemptId}/annotations`, `/api/questions/${questionId}/annotations`]
      : [`/api/questions/${questionId}/annotations`];
    for (const path of paths) {
      try {
        const data = await request<{ highlights: unknown[] }>(path);
        return data.highlights ?? [];
      } catch {
        /* try next */
      }
    }
    return null;
  },
  // LSAT-6 — Annotation Notebook knowledge base. FTS search over note text +
  // user explanations; backlinks (question:/attempt:/tag:); inline authoring.
  searchAnnotations: (q: string, limit = 20) =>
    request<AnnotationSearchResult>(
      `/api/annotations/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  // Namespaced under /api/annotations/backlinks/ (NOT /api/backlinks, which the
  // notebook artifact backlink list owns). Returns { target, count, backlinks }.
  getAnnotationBacklinks: (target: string) =>
    request<AnnotationBacklinksResult>(
      `/api/annotations/backlinks/${encodeURIComponent(target)}`,
    ).then((r) => r.backlinks ?? []),
  getAnnotationExplanation: (annotationId: number) =>
    request<AnnotationExplanation>(
      `/api/annotations/${annotationId}/explanation`,
    ),
  saveAnnotationExplanation: (annotationId: number, userExplanation: string) =>
    request<{ ok: boolean; annotation_id: number; user_explanation: string }>(
      `/api/annotations/${annotationId}/explanation`,
      { method: "POST", json: { user_explanation: userExplanation } },
    ),
  saveAnnotationTags: (annotationId: number, tags: string[]) =>
    request<{ ok: boolean; annotation_id: number; tags: string[] }>(
      `/api/annotations/${annotationId}/tags`,
      { method: "PUT", json: { tags } },
    ),
  saveAnnotations: async (
    questionId: number,
    highlights: unknown[],
    attemptId?: number,
  ): Promise<boolean> => {
    const body = { highlights };
    const attempts: { method: "PUT" | "POST"; path: string }[] = attemptId
      ? [
          { method: "PUT", path: `/api/attempts/${attemptId}/annotations` },
          { method: "POST", path: `/api/questions/${questionId}/annotations` },
        ]
      : [
          { method: "PUT", path: `/api/questions/${questionId}/annotations` },
          { method: "POST", path: `/api/questions/${questionId}/annotations` },
        ];
    for (const { method, path } of attempts) {
      try {
        await request(path, { method, json: body });
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  },

  // --- Round 5 endpoints ---------------------------------------------------
  // AI
  coach: () => request<CoachSnapshot>("/api/ai/coach"),
  coachRefresh: () =>
    request<CoachSnapshot>("/api/ai/coach/refresh", { method: "POST", json: {} }),
  hint: (questionId: number, mode = "study") =>
    request<{ hint: string }>("/api/ai/hint", {
      method: "POST",
      json: { question_id: questionId, mode },
    }),
  pregenerate: (limit = 20, sources?: string[]) =>
    request<{ explained: number; remaining: number }>("/api/ai/pregenerate", {
      method: "POST",
      json: { limit, sources },
    }),

  // Analytics v2
  mastery: (source: "official" | "all" = "all", days?: number) =>
    request<MasteryRow[]>(
      appendDaysQuery(`/api/analytics/mastery?source=${source}`, days),
    ),
  forecast: (examDate?: string | null, targetScore?: number | null, days?: number) => {
    const params = new URLSearchParams();
    if (examDate) params.set("exam_date", examDate);
    if (targetScore != null) params.set("target_score", String(targetScore));
    const base = `/api/analytics/forecast${params.toString() ? `?${params}` : ""}`;
    return request<Forecast>(appendDaysQuery(base, days), {
      validate: forecastSchema as unknown as z.ZodType<Forecast>,
    });
  },
  analyticsType: (qType: string, days?: number) =>
    request<TypeAnalytics>(
      appendDaysQuery(`/api/analytics/type/${encodeURIComponent(qType)}`, days),
    ),
  focusQuality: (sessionId: number) =>
    request<FocusQuality>(`/api/analytics/focus/${sessionId}`),
  report: (days = 120) =>
    request<Record<string, unknown>>(`/api/analytics/report?days=${days}`),

  // Sessions / exams / progress
  preptestProgress: (id: number) =>
    request<PrepTestProgress>(`/api/preptests/${id}/progress`),
  createExam: (preptestId: number) =>
    request<ExamSession>("/api/exams", { method: "POST", json: { preptest_id: preptestId } }),
  examResults: (sessionId: number) =>
    request<ExamResults>(`/api/exams/${sessionId}/results`),
  reflection: (sessionId: number) =>
    request<Reflection>(`/api/sessions/${sessionId}/reflection`),
  saveReflection: (sessionId: number, body: { text: string; prompts?: string[] }) =>
    request<{ id: number; session_id: number; text: string; prompts: string[] }>(
      `/api/sessions/${sessionId}/reflection`,
      { method: "POST", json: body },
    ),

  // Study plan
  studyPlan: () => request<StudyPlan>("/api/study/plan"),
  saveStudyPlan: (body: { target_score: number; exam_date?: string | null; daily_minutes?: number }) =>
    request<StudyPlan>("/api/study/plan", { method: "PUT", json: body }),
  today: () => request<TodayPlan>("/api/study/today"),
  todayFeedback: (body: TodayPlanFeedbackBody) =>
    request<ActivityEvent>("/api/study/today/feedback", {
      method: "POST",
      json: body,
    }),

  // Settings / observability
  settings: () => request<Settings>("/api/settings"),
  // Body mirrors the backend `SettingsPatch`: model/provider fields are strings,
  // but `desired_retention` is numeric — hence `string | number`.
  saveSettings: (patch: Record<string, string | number>) =>
    request<Settings>("/api/settings", { method: "PUT", json: patch }),
  observabilityStatus: () =>
    request<ObservabilityStatus>("/api/observability/status"),
  runtimeEvidence: () =>
    request<RuntimeEvidence>("/api/observability/runtime-evidence"),

  // X2 / D4 — local backups + integrity (Diagnostics panel)
  backupList: () => request<BackupList>("/api/backup/list"),
  backupNow: () =>
    request<{ created: string }>("/api/backup/now", { method: "POST", json: {} }),
  backupIntegrity: () => request<BackupIntegrity>("/api/backup/integrity"),
  backupRestore: (name: string) =>
    request<BackupRestoreResult>("/api/backup/restore", {
      method: "POST",
      json: { name },
    }),

  // Generation queue / coverage / triage
  genJobs: (limit = 50) => request<GenJobSummary[]>(`/api/gen/jobs?limit=${limit}`),
  genCoverage: () => request<CoverageRow[]>("/api/gen/coverage"),
  genForType: (qType: string, count = 5, activate = true) =>
    request<{ enqueued: boolean; job_id?: number; status?: string; reason?: string }>(
      "/api/gen/for-type",
      { method: "POST", json: { q_type: qType, count, activate } },
    ),
  quarantineTriage: (questionId: number) =>
    request<QuarantineTriage>(`/api/gen/quarantine/${questionId}/triage`),

  // Bank quality
  bankAudit: () => request<BankAudit>("/api/bank/audit"),
  bankDuplicates: (threshold = 0.95) =>
    request<DuplicateCluster[]>(`/api/bank/duplicates?threshold=${threshold}`),
  bankEmbed: (limit = 200) =>
    request<{ embedded: number; remaining: number; total_questions: number }>(
      "/api/bank/embed",
      { method: "POST", json: { limit } },
    ),
  bankTagReview: (limit = 50) =>
    request<Question[]>(`/api/bank/tag-review?limit=${limit}`),

  // Drills (NL intent) + SRS bulk
  drillIntent: (text: string) =>
    request<DrillConfig>("/api/drills/intent", { method: "POST", json: { text } }),
  srsCardsBulk: (questionIds: number[]) =>
    request<{ created: number; skipped: number; card_ids: number[] }>(
      "/api/srs/cards",
      { method: "POST", json: { question_ids: questionIds } },
    ),

  // Error log mutations
  deleteErrorLog: (id: number) =>
    request<{ ok: boolean }>(`/api/error-log/${id}`, { method: "DELETE" }),
  editErrorLog: (id: number, body: { reason?: ErrorReason; note?: string }) =>
    request<{ ok: boolean; id: number }>(`/api/error-log/${id}`, {
      method: "PATCH",
      json: body,
    }),

  // Similar (typed) — real endpoint with embedding fallback handled below.
  similar: (id: number, k = 5) =>
    request<SimilarQuestion[]>(`/api/questions/${id}/similar?k=${k}`),

  // --- Wave 3/4 endpoints --------------------------------------------------
  // Q1 — explanation feedback loop. A 👎 marks the explanation to regenerate
  // next time it is requested.
  explainFeedback: (body: {
    question_id: number;
    helpful: boolean;
    note?: string;
  }) =>
    request<{ ok: boolean; will_regenerate: boolean }>("/api/ai/explain/feedback", {
      method: "POST",
      json: body,
    }),

  // X3 — coach → tutor chat (single reply, no streaming).
  coachChat: (body: { message: string; history?: ChatTurn[] }) =>
    request<{ reply: string }>("/api/ai/coach/chat", {
      method: "POST",
      json: body,
    }),

  // Q2 — generation-quality analytics.
  genQuality: () => request<GenQuality>("/api/gen/quality"),
  // Q5 — approved-AI drift watch.
  genDrift: (minAttempts?: number, floor?: number) => {
    const params = new URLSearchParams();
    if (minAttempts != null) params.set("min_attempts", String(minAttempts));
    if (floor != null) params.set("floor", String(floor));
    const qs = params.toString();
    return request<GenDrift>(`/api/gen/drift${qs ? `?${qs}` : ""}`);
  },
  requarantine: (id: number) =>
    request<{ ok: boolean }>(`/api/gen/quarantine/${id}/requarantine`, {
      method: "POST",
    }),

  // D5 — soft-delete + restore in the bank browser.
  deleteQuestion: (id: number) =>
    request<{ ok: boolean; deleted_at: string }>(`/api/questions/${id}`, {
      method: "DELETE",
    }),
  restoreQuestion: (id: number) =>
    request<{ ok: boolean }>(`/api/questions/${id}/restore`, {
      method: "POST",
    }),
};

/** Outcome of a single SSE attempt. */
type StreamAttemptResult =
  | { kind: "done" } // clean completion
  | { kind: "error"; error: Error } // definitive, non-retryable failure
  | { kind: "interrupted"; error: Error }; // network drop — retryable

export interface NotebookContextMeta {
  count: number;
  items: { kind: string; id: number; title: string; reason: string }[];
}

export interface SocraticExplainMeta {
  personalized: boolean;
  attempt_id?: number | null;
  conversation_id?: number | null;
  rationale_count?: number;
  turn_count?: number;
  trap_guess?: string | null;
}

/** Max auto-reconnects after a mid-stream drop before surfacing onError (5.7). */
const SSE_MAX_RETRIES = 3;
/** Backoff base; attempt n waits ~BASE * 2^(n-1), capped. */
const SSE_BACKOFF_BASE_MS = 400;
const SSE_BACKOFF_CAP_MS = 4000;

function sseBackoffMs(attempt: number): number {
  return Math.min(SSE_BACKOFF_CAP_MS, SSE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/**
 * Stream a question explanation from the SSE endpoint.
 * The contract: POST /api/ai/explain -> text/event-stream with lines like
 *   data: {"token":"..."}
 *   data: {"done":true,"explanation_id":N}
 *
 * EventSource cannot POST, so we use fetch() + a ReadableStream reader.
 *
 * 5.7 — a mid-stream network drop auto-reconnects up to {@link SSE_MAX_RETRIES}
 * times with exponential backoff before surfacing the existing manual Retry path
 * via onError. Because a reconnect re-streams from the start, `onReconnect` lets
 * the caller reset its accumulated text so tokens are not duplicated. An explicit
 * AbortController abort is never retried and never reported as an error.
 */
export async function streamExplain(
  body: {
    question_id: number;
    chosen_answer: string | null;
    attempt_id?: number | null;
    conversation_id?: number | null;
    user_message?: string;       // A1: follow-up question
    focus_choice?: string | null; // A1: focus on a specific choice
  },
  handlers: {
    onToken: (token: string) => void;
    onChoice?: (label: string, text: string) => void; // A4: per-choice events
    onDone?: (
      explanationId?: number,
      meta?: {
        cached?: boolean;
        per_choice?: Record<string, string>;
        notebook_context?: NotebookContextMeta;
        socratic_context?: SocraticExplainMeta;
        trap_patterns?: TrapPatternsMeta;
      }, // A2
    ) => void;
    onError?: (err: Error) => void;
    /** Fired before a reconnect attempt so the caller can clear partial output. */
    onReconnect?: (attempt: number) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const started = Date.now();
  const signal = handlers.signal;

  // BB2 — the SSE wire shape this endpoint speaks. The unified stream reader
  // (src/lib/streamingClient.ts) handles the `data:`/blank-line framing, the
  // `[DONE]` sentinel, non-JSON lines, timeouts and cancellation; this parser
  // only maps a parsed `data:` object onto the four event kinds, carrying the
  // full object through on `done` so the explain-specific metadata (per_choice,
  // notebook_context, socratic_context, choice/text) survives. The handler
  // dispatch below keeps the exact prior semantics (choice → onChoice,
  // token → onToken, done → onDone with metadata).
  const parseExplainSse: SseParser = (raw) => {
    if (typeof raw !== "object" || raw === null) {
      // A bare non-object JSON value: treat as a raw token (matches the old
      // "non-JSON data line → token" fallthrough for primitive payloads).
      return { kind: "delta", text: String(raw) };
    }
    const obj = raw as {
      token?: string;
      choice?: string;
      text?: string;
      done?: boolean;
      error?: string;
    };
    if (obj.error) {
      // A server-emitted error is a definitive failure, not a network drop.
      return { kind: "error", message: obj.error };
    }
    // A per-choice frame OR a token frame both ride the `delta` event; the
    // dispatcher decides which handler to call from the carried `data`.
    if ((obj.choice && obj.text !== undefined) || obj.token) {
      return { kind: "delta", text: obj.token ?? "", data: obj };
    }
    if (obj.done) {
      return { kind: "done", meta: obj };
    }
    // An unrecognised frame: ignore (e.g. a keep-alive / metadata-only line).
    return null;
  };

  // One fetch + read pass. Resolves with how the attempt ended. The transport
  // (fetch + body read + SSE framing + timeout/abort) is the unified client;
  // this function only classifies the terminal outcome the way the reconnect
  // loop below expects (done / definitive error / retryable interruption).
  async function runAttempt(): Promise<StreamAttemptResult> {
    // Track whether we saw a clean terminal so a body that simply ends (no
    // explicit done sentinel) still counts as complete, mirroring the old path.
    let settled = false;
    let outcome: StreamAttemptResult = { kind: "done" };
    try {
      for await (const ev of streamEvents(
        `${PREFIX}/api/ai/explain`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        },
        {
          signal,
          parseSse: parseExplainSse,
          // Reconnect/backoff already guards stalls at the loop level; the
          // unified stall watchdog still trips a wedged model into a DISTINCT
          // timeout event (handled below) instead of hanging indefinitely.
        },
      )) {
        if (ev.type === "delta") {
          const obj = ev.data as
            | { choice?: string; text?: string; token?: string }
            | undefined;
          if (obj?.choice && obj.text !== undefined) {
            handlers.onChoice?.(obj.choice, obj.text);
          } else if (obj?.token) {
            handlers.onToken(obj.token);
          } else if (ev.text) {
            // Raw token (non-JSON data line) surfaced by the reader.
            handlers.onToken(ev.text);
          }
        } else if (ev.type === "done") {
          const meta = ev.meta as
            | {
                explanation_id?: number;
                cached?: boolean;
                per_choice?: Record<string, string>;
                notebook_context?: NotebookContextMeta;
                socratic_context?: SocraticExplainMeta;
                trap_patterns?: TrapPatternsMeta;
              }
            | undefined;
          handlers.onDone?.(meta?.explanation_id, {
            cached: meta?.cached,
            per_choice: meta?.per_choice,
            notebook_context: meta?.notebook_context,
            socratic_context: meta?.socratic_context,
            trap_patterns: meta?.trap_patterns,
          });
          settled = true;
          outcome = { kind: "done" };
          break;
        } else if (ev.type === "timeout") {
          // A wedged model — definitive (do NOT retry-storm a stuck server).
          settled = true;
          outcome = { kind: "error", error: ev.error };
          break;
        } else {
          // ev.type === "error"
          settled = true;
          const err = ev.error;
          const status = (err as { status?: number }).status;
          if (typeof status === "number") {
            // Non-OK HTTP. 5xx / 0 are transient; 4xx are definitive.
            const apiErr = new ApiError(`Explain failed (${status})`, status);
            const retryable = status === 0 || status >= 500;
            outcome = retryable
              ? { kind: "interrupted", error: apiErr }
              : { kind: "error", error: apiErr };
          } else {
            // A connection / mid-read drop — retryable interruption.
            outcome = { kind: "interrupted", error: err };
          }
          break;
        }
      }
    } catch (err) {
      // streamEvents does not throw for stream outcomes, but a thrown error
      // here (defensive) is treated as a retryable interruption.
      return { kind: "interrupted", error: err as Error };
    }

    if (!settled) {
      // Body ended without an explicit done sentinel (or was aborted silently
      // mid-stream). The outer loop re-checks `signal` for the abort case; a
      // natural end is a clean completion.
      handlers.onDone?.();
      return { kind: "done" };
    }
    return outcome;
  }

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return;
    let result: StreamAttemptResult;
    try {
      result = await runAttempt();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      result = { kind: "interrupted", error: err as Error };
    }

    if (signal?.aborted) return; // aborted mid-attempt — stay silent
    if (result.kind === "done") {
      recordExplainLatency(Date.now() - started);
      return;
    }
    if (result.error.name === "AbortError") return;

    const canRetry = result.kind === "interrupted" && attempt <= SSE_MAX_RETRIES;
    if (!canRetry) {
      handlers.onError?.(result.error);
      return;
    }

    // Back off, then reconnect (telling the caller to reset partial output).
    const waitMs = sseBackoffMs(attempt);
    const interrupted = await sleepUnlessAborted(waitMs, signal);
    if (interrupted) return; // aborted during the wait
    handlers.onReconnect?.(attempt);
  }
}

/**
 * LSAT-4 — stream a Socratic reply for a new turn over SSE.
 *
 * Contract: POST /api/conversations/{id}/turns-stream -> text/event-stream with
 *   data: {"token":"..."}
 *   data: {"done":true,"turn":{...},"reply":{...},"socratic_context":{...}}
 *
 * Builds on the unified stream reader (BB2). Unlike streamExplain it does NOT
 * auto-reconnect: the user turn + assistant reply are persisted server-side
 * before the first token, so a dropped connection is recovered by re-fetching
 * the conversation rather than re-POSTing (which would append a duplicate turn).
 * A caller abort ends silently; any other terminal surfaces through onError.
 */
export async function streamSocraticTurn(
  conversationId: number,
  body: { role?: "user" | "assistant"; content: string; auto_reply?: boolean },
  handlers: {
    onToken: (token: string) => void;
    onDone?: (meta?: SocraticTurnStreamDone) => void;
    onError?: (err: Error) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { signal } = handlers;
  const parseSocraticSse: SseParser = (raw) => {
    if (typeof raw !== "object" || raw === null) {
      return { kind: "delta", text: String(raw) };
    }
    const obj = raw as { token?: string; done?: boolean; error?: string };
    if (obj.error) return { kind: "error", message: obj.error };
    if (obj.token) return { kind: "delta", text: obj.token, data: obj };
    if (obj.done) return { kind: "done", meta: obj };
    return null;
  };

  let settled = false;
  for await (const ev of streamEvents(
    `${PREFIX}/api/conversations/${conversationId}/turns-stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ auto_reply: true, role: "user", ...body }),
    },
    { signal, parseSse: parseSocraticSse },
  )) {
    if (ev.type === "delta") {
      const token = (ev.data as { token?: string } | undefined)?.token ?? ev.text;
      if (token) handlers.onToken(token);
    } else if (ev.type === "done") {
      handlers.onDone?.(ev.meta as SocraticTurnStreamDone | undefined);
      settled = true;
      return;
    } else if (ev.type === "timeout") {
      handlers.onError?.(ev.error);
      settled = true;
      return;
    } else {
      handlers.onError?.(ev.error);
      settled = true;
      return;
    }
  }
  if (!settled && !signal?.aborted) handlers.onDone?.();
}

/** Resolve after `ms`, or immediately (true) if the signal aborts first. */
function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve(true);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
