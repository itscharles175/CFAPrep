// Runtime validation (zod) for the HOT paths only — the take → blind-review →
// explain loop plus the two surfaces it routes through (forecast/dashboard).
//
// 5.1 — `request<T>` keeps the bare `as T` cast for the long tail of endpoints,
// but the few shapes the core loop depends on are `.parse()`d so a backend
// contract drift surfaces as a typed `ApiValidationError` (caught by the
// existing ErrorBoundary) instead of corrupting state silently downstream.
//
// Schemas are intentionally permissive (`.passthrough()` / `.partial()` where
// the backend may add fields) and validate only the fields the UI relies on, so
// an additive backend change never breaks an existing client. They must not
// CONTRADICT `api.gen.ts` for these shapes.
import { z } from "zod";

export class ApiValidationError extends Error {
  /** The endpoint path that produced the malformed payload. */
  path: string;
  /** The underlying zod issues, for diagnostics. */
  issues: z.ZodIssue[];
  constructor(path: string, issues: z.ZodIssue[]) {
    const first = issues[0];
    super(
      `Unexpected response shape from ${path}` +
        (first ? `: ${first.path.join(".")} ${first.message}` : ""),
    );
    this.name = "ApiValidationError";
    this.path = path;
    this.issues = issues;
  }
}

// --- shared leaf schemas ---------------------------------------------------
const choiceSchema = z
  .object({
    id: z.number(),
    label: z.string(),
    text: z.string(),
    is_correct: z.boolean().optional(),
    trap_type: z.string().optional(),
  })
  .passthrough();

const questionSchema = z
  .object({
    id: z.number(),
    section_id: z.number().nullable(),
    passage_id: z.number().nullable(),
    prompt: z.string(),
    stem: z.string(),
    q_type: z.string(),
    difficulty: z.number(),
    source: z.string(),
    choices: z.array(choiceSchema),
  })
  .passthrough();

const passageSchema = z
  .object({
    id: z.number(),
    text: z.string(),
    type: z.string(),
    topic: z.string().optional(),
  })
  .passthrough();

// --- hot-path response schemas ---------------------------------------------

/** GET /api/sections/{id} */
export const sectionDetailSchema = z
  .object({
    id: z.number(),
    preptest_id: z.number(),
    type: z.string(),
    time_limit_sec: z.number(),
    passages: z.array(passageSchema),
    questions: z.array(questionSchema),
  })
  .passthrough();

/** GET /api/questions/{id} */
export const questionResponseSchema = questionSchema;

const attemptInfoSchema = z
  .object({
    attempt_id: z.number(),
    chosen_answer: z.string().nullable(),
    br_answer: z.string().nullable(),
    is_correct: z.boolean(),
    br_correct: z.boolean().nullable(),
    time_ms: z.number(),
    outcome: z.string(),
  })
  .passthrough();

/** GET /api/sessions/{id}/results */
export const sessionResultsSchema = z
  .object({
    session: z
      .object({
        id: z.number(),
        type: z.string(),
        started: z.string(),
      })
      .passthrough(),
    items: z.array(
      z
        .object({
          question: questionSchema,
          attempt: attemptInfoSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** POST /api/sessions/{id}/finish */
export const finishResultSchema = z
  .object({
    raw_correct: z.number(),
    total: z.number(),
    scaled_score: z.number().optional(),
  })
  .passthrough();

/** GET /api/analytics/forecast */
export const forecastSchema = z
  .object({
    current_score: z.number().nullable(),
    projected_score: z.number().nullable(),
    slope_per_week: z.number(),
    confidence: z
      .object({ low: z.number(), high: z.number() })
      .passthrough()
      .nullable(),
    target_score: z.number().nullable(),
    gap_to_target: z.number().nullable(),
    on_track: z.boolean().nullable(),
    days_to_exam: z.number().nullable(),
    n_points: z.number(),
  })
  .passthrough();

/** GET /api/analytics/dashboard */
export const dashboardSchema = z
  .object({
    predicted_score: z.number().nullable(),
    score_delta_30d: z.number().nullable(),
    trend: z.array(
      z.object({ date: z.string(), score: z.number() }).passthrough(),
    ),
    weakest_types: z.array(z.object({ q_type: z.string() }).passthrough()),
    coach: z
      .object({
        text: z.string(),
        recommendation: z
          .object({ label: z.string(), action: z.object({ type: z.string() }).passthrough() })
          .passthrough(),
      })
      .passthrough(),
    streak_days: z.number(),
  })
  .passthrough();

export const regressionAlertsSchema = z
  .object({
    model: z.string(),
    source: z.string(),
    recent_days: z.number(),
    baseline_days: z.number(),
    min_attempts: z.number(),
    min_drop: z.number(),
    status: z.string(),
    alerts: z.array(
      z
        .object({
          q_type: z.string(),
          section_type: z.string(),
          recent_attempts: z.number(),
          baseline_attempts: z.number(),
          recent_correct: z.number(),
          baseline_correct: z.number(),
          recent_accuracy: z.number(),
          baseline_accuracy: z.number(),
          delta: z.number(),
          z_score: z.number().nullable(),
          statistically_significant: z.boolean(),
          severity: z.string(),
          reason: z.string(),
        })
        .passthrough(),
    ),
    summary: z
      .object({
        alert_count: z.number(),
        checked_types: z.number(),
        insufficient_types: z.number(),
        recent_window_start: z.string(),
        baseline_window_start: z.string(),
      })
      .passthrough(),
    insufficient: z.array(
      z
        .object({
          q_type: z.string(),
          section_type: z.string(),
          recent_attempts: z.number(),
          baseline_attempts: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const recordSchema = z.record(z.string(), z.unknown());
const citationWireSchema = z
  .union([
    z.string(),
    z.object({ target: z.string().optional() }).passthrough(),
  ]);

export const workspaceManifestSchema = z
  .object({
    id: z.number(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    home_artifact_id: z.number().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const evidenceRefSchema = z
  .object({
    id: z.number().optional(),
    artifact_id: z.number().optional(),
    kind: z.string(),
    entity_id: z.string(),
    target: z.string(),
    quote: z.string().optional(),
    range: recordSchema.optional(),
    line_ref: z.string().nullable().optional(),
    reveal_state: z.string().optional(),
    official_firewall: z.boolean().optional(),
    label: z.string().optional(),
    meta: recordSchema.optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

export const citationTargetSchema = z
  .object({
    id: z.number().optional(),
    artifact_id: z.number().nullable().optional(),
    target: z.string(),
    target_kind: z.string().optional(),
    kind: z.string().optional(),
    entity_id: z.string().optional(),
    exists: z.boolean().optional(),
    label: z.string(),
    snippet: z.string().optional(),
    official_firewall: z.boolean(),
    cloud_allowed: z.boolean().optional(),
    export_eligible: z.boolean().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

export const studyArtifactSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    summary: z.string(),
    source_kind: z.string(),
    q_type: z.string().nullable().optional(),
    question_id: z.number().nullable().optional(),
    attempt_id: z.number().nullable().optional(),
    passage_id: z.number().nullable().optional(),
    visibility: z.string(),
    official_firewall: z.boolean(),
    cloud_allowed: z.boolean(),
    export_eligible: z.boolean(),
    tags: z.array(z.string()),
    meta: recordSchema,
    evidence_refs: z.array(evidenceRefSchema).optional(),
    citations: z.array(citationTargetSchema).optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const artifactVersionSchema = z
  .object({
    id: z.number(),
    artifact_id: z.number(),
    version: z.number(),
    reason: z.string(),
    snapshot: recordSchema,
    created_at: z.string(),
  })
  .passthrough();

export const backlinkSchema = z
  .object({
    id: z.number(),
    source_artifact_id: z.number().nullable().optional(),
    source_title: z.string(),
    source_kind: z.string(),
    source_summary: z.string(),
    source_official_firewall: z.boolean(),
    target_ref: z.string(),
    relation: z.string(),
    q_type: z.string().nullable().optional(),
    trap: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    meta: recordSchema,
    created_at: z.string(),
  })
  .passthrough();

export const knowledgeInboxItemSchema = z
  .object({
    id: z.number(),
    artifact_id: z.number().nullable().optional(),
    artifact_title: z.string(),
    origin: z.string(),
    status: z.string(),
    priority: z.number(),
    reason: z.string(),
    created_at: z.string(),
    resolved_at: z.string().nullable().optional(),
  })
  .passthrough();

export const notebookSourceSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    artifact_id: z.number().nullable().optional(),
    title: z.string(),
    source_type: z.string(),
    status: z.string(),
    content_type: z.string(),
    provider: z.string(),
    official_firewall: z.boolean(),
    processing: recordSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const notebookNoteSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    artifact_id: z.number().nullable().optional(),
    note_type: z.string(),
    title: z.string(),
    content: z.string(),
    citations: z.array(citationWireSchema),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const notebookSearchSchema = z
  .object({
    query: z.string(),
    artifacts: z.array(studyArtifactSchema),
    notes: z.array(notebookNoteSchema),
    sources: z.array(notebookSourceSchema),
    artifact_search: z
      .object({
        mode: z.string(),
        fallback_used: z.boolean(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const notebookChatMessageSchema = z
  .object({
    id: z.number(),
    session_id: z.number(),
    role: z.string(),
    content: z.string(),
    citations: z.array(citationWireSchema),
    meta: recordSchema,
    created_at: z.string(),
  })
  .passthrough();

export const notebookChatSessionSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    title: z.string(),
    mode: z.string(),
    model: z.string(),
    context: recordSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const notebookChatTurnResultSchema = z
  .object({
    user: notebookChatMessageSchema,
    assistant: notebookChatMessageSchema,
    firewall_decision: recordSchema,
  })
  .passthrough();

export const transformationRunSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    template_key: z.string(),
    status: z.string(),
    prompt: z.string(),
    input_refs: z.array(citationWireSchema),
    output_artifact_id: z.number().nullable().optional(),
    provider: z.string(),
    model: z.string(),
    firewall_decision: recordSchema,
    metrics: recordSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const podcastEpisodeSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    title: z.string(),
    episode_type: z.string(),
    status: z.string(),
    transcript: z.string(),
    audio_path: z.string().nullable().optional(),
    source_refs: z.array(citationWireSchema),
    provider: z.string(),
    firewall_decision: recordSchema,
    duration_sec: z.number().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const activityEventSchema = z
  .object({
    id: z.number(),
    kind: z.string(),
    status: z.string(),
    title: z.string(),
    detail: recordSchema,
    entity: z.string(),
    entity_id: z.number().nullable().optional(),
    progress_pct: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const contextPresetSchema = z
  .object({
    id: z.number(),
    workspace_id: z.number().nullable().optional(),
    name: z.string(),
    modes: recordSchema,
    policy: recordSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

const rcTimingByTypeSchema = z
  .object({
    attempts: z.number(),
    avg_time_ms: z.number(),
    accuracy: z.number(),
  })
  .passthrough();

const rcTimingSchema = z
  .object({
    attempts: z.number(),
    avg_time_ms: z.number().nullable(),
    accuracy: z.number().nullable(),
    by_q_type: z.record(z.string(), rcTimingByTypeSchema),
  })
  .passthrough();

const rcTagCoverageSchema = z
  .object({
    tagged_questions: z.number(),
    total_questions: z.number(),
    coverage: z.number(),
    low_confidence: z.number(),
    by_scope: z.record(z.string(), z.number()),
  })
  .passthrough();

const rcQuestionTagSchema = z
  .object({
    question_id: z.number(),
    q_type: z.string(),
    scope: z.string(),
    anchor_ref: z.string().optional(),
    requires_evidence: z.boolean().optional(),
    tags: z.array(z.string()),
    tag_confidence: z.number(),
  })
  .passthrough();

const rcEvidenceRefSchema = z
  .object({
    paragraph_index: z.number().optional(),
    line_ref: z.string(),
    marker: z.string(),
    evidence_type: z.string(),
    text_preview: z.string(),
  })
  .passthrough();

export const rcPassageMapSchema = z
  .object({
    analysis_id: z.number().optional(),
    passage_id: z.number(),
    topic: z.string().nullable().optional(),
    structure: z
      .object({
        paragraph_count: z.number(),
        passage_type: z.string(),
        topic: z.string().nullable().optional(),
        main_point_hint: z.string(),
        question_mix: z.record(z.string(), z.number()),
        line_reference_density: z.number(),
        viewpoint_count: z.number().optional(),
        dominant_viewpoint: z.string().nullable().optional(),
        evidence_anchor_count: z.number().optional(),
        tag_coverage: rcTagCoverageSchema.optional(),
      })
      .passthrough(),
    paragraph_roles: z.array(
      z
        .object({
          index: z.number(),
          line_ref: z.string().optional(),
          role: z.string(),
          author_attitude: z.string(),
          claim_density: z.number(),
          viewpoint: recordSchema.optional(),
          evidence_markers: z.array(z.string()).optional(),
          text_preview: z.string(),
        })
        .passthrough(),
    ),
    evidence_refs: z.array(rcEvidenceRefSchema).optional(),
    question_tags: z.array(rcQuestionTagSchema).optional(),
    timing: rcTimingSchema,
    generated_by: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const rcDashboardSchema = z
  .object({
    passages: z.number(),
    questions: z.number(),
    mapped_passages: z.number(),
    coverage: z.number(),
    by_q_type: z.record(z.string(), z.number()),
    tag_coverage: rcTagCoverageSchema.optional(),
    timing: rcTimingSchema,
    next_actions: z.array(z.string()),
  })
  .passthrough();

const provenanceScoreSourceSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    source_type: z.string(),
    license: z.string().nullable().optional(),
    question_count: z.number(),
    score: z.number(),
    status: z.string(),
    reasons: z.array(z.string()),
    eligibility: recordSchema,
    firewall: recordSchema,
    seeded_from: z.string().nullable().optional(),
    quality: z.record(z.string(), z.number()),
  })
  .passthrough();

export const contentRevalidationTargetSchema = z
  .object({
    question_id: z.number(),
    q_type: z.string(),
    section_type: z.string().nullable(),
    source: z.string(),
    content_fingerprint: z.string(),
    latest_run_id: z.number().nullable().optional(),
    latest_status: z.string().nullable().optional(),
    latest_created_at: z.string().nullable().optional(),
    needs_revalidation: z.boolean(),
    reasons: z.array(z.string()),
    choice_count: z.number(),
    has_passage: z.boolean(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

export const contentRevalidationReportSchema = z
  .object({
    approved_ai_count: z.number(),
    due_count: z.number(),
    failed_count: z.number(),
    rc_count: z.number(),
    missing_evidence_count: z.number(),
    queue: z.array(contentRevalidationTargetSchema),
    recent_failures: z.array(contentRevalidationTargetSchema),
    lookback: z.number(),
    mode: z.string(),
  })
  .passthrough();

export const contentRevalidationRunResultSchema = z
  .object({
    ok: z.boolean(),
    validated: z.number(),
    passed: z.number(),
    failed: z.number(),
    quarantined: z.number(),
    quarantined_question_ids: z.array(z.number()),
    model_gate: z.boolean(),
    apply_quarantine: z.boolean(),
    force: z.boolean(),
    runs: z.array(
      z
        .object({
          question_id: z.number(),
          validator_run_id: z.number(),
          status: z.string(),
          score: z.number().nullable(),
          failure_reasons: z.array(z.string()),
          model_gate: z.boolean(),
          quarantined: z.boolean(),
        })
        .passthrough(),
    ),
    remaining: contentRevalidationReportSchema,
  })
  .passthrough();

export const contentRevalidationRemediationResultSchema = z
  .object({
    ok: z.boolean(),
    action: z.string(),
    question_id: z.number(),
    validator_run_id: z.number().nullable().optional(),
    version: z
      .object({
        id: z.number(),
        entity: z.string(),
        entity_id: z.number(),
        version: z.number(),
        reason: z.string(),
        snapshot: recordSchema,
        created_at: z.string(),
      })
      .passthrough(),
    question: z
      .object({
        id: z.number(),
        approved: z.boolean(),
        quarantined: z.boolean(),
        updated_at: z.string().nullable().optional(),
      })
      .passthrough(),
    remaining: contentRevalidationReportSchema,
  })
  .passthrough();

export const contentDuplicateRemediationResultSchema = z
  .object({
    ok: z.boolean(),
    action: z.string(),
    cluster_key: z.string(),
    duplicate_kind: z.string().nullable().optional(),
    canonical_question_id: z.number(),
    quarantined_question_ids: z.array(z.number()),
    versions: z.array(
      z
        .object({
          id: z.number(),
          entity: z.string(),
          entity_id: z.number(),
          version: z.number(),
          reason: z.string(),
          snapshot: recordSchema,
          created_at: z.string(),
        })
        .passthrough(),
    ),
    remaining: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const contentHealthSchema = z
  .object({
    total_questions: z.number(),
    score: z.number(),
    status: z.string(),
    warnings: z.array(z.string()),
    by_source: z.record(z.string(), z.number()),
    by_q_type: z.record(z.string(), z.number()),
    tag_confidence: z
      .object({
        low: z.number(),
        low_question_ids: z.array(z.number()),
      })
      .passthrough(),
    quarantine: z
      .object({
        count: z.number(),
        question_ids: z.array(z.number()),
      })
      .passthrough(),
    duplicates: z
      .object({
        clusters: z.array(
          z
            .object({
              content_hash: z.string(),
              cluster_key: z.string().optional(),
              duplicate_kind: z.string().optional(),
              count: z.number(),
              question_ids: z.array(z.number()).optional(),
              recommended_canonical_id: z.number().nullable().optional(),
              quarantine_candidate_ids: z.array(z.number()).optional(),
              source_mix: z.record(z.string(), z.number()).optional(),
              q_type_mix: z.record(z.string(), z.number()).optional(),
              sample: z.string().optional(),
            })
            .passthrough(),
        ),
        cluster_count: z.number(),
      })
      .passthrough(),
    official_firewall: z.object({ ok: z.boolean() }).passthrough(),
    validator_coverage: z.object({ known_validator_types: z.array(z.string()) }).passthrough(),
    choice_integrity: z.object({ nonstandard_choice_count: z.number() }).passthrough(),
    versioning: z.object({ snapshots: z.number(), by_entity: z.record(z.string(), z.number()) }).passthrough(),
    provenance_score: z
      .object({
        score: z.number(),
        status: z.string(),
        summary: z.string(),
        blocked_source_keys: z.array(z.string()),
        warning_source_keys: z.array(z.string()),
        sources: z.array(provenanceScoreSourceSchema),
      })
      .passthrough()
      .optional(),
    revalidation: contentRevalidationReportSchema.optional(),
  })
  .passthrough();

export const sourcePolicyReviewSchema = z
  .object({
    source_key: z.string(),
    question_count: z.number(),
    requires_review: z.boolean(),
    risks: z.array(
      z
        .object({
          code: z.string(),
          severity: z.string(),
          detail: z.string(),
        })
        .passthrough(),
    ),
    acknowledged_risks: z.array(z.string()),
    missing_acknowledgements: z.array(z.string()),
    reviewed: z.boolean(),
    reviewer_note: z.string().optional(),
  })
  .passthrough();

export const contentSourceRegistrySchema = z
  .object({
    id: z.number(),
    key: z.string(),
    label: z.string(),
    source_type: z.string(),
    license: z.string().nullable().optional(),
    eligibility: recordSchema,
    firewall: recordSchema,
    updated_at: z.string(),
    policy_review: sourcePolicyReviewSchema.optional(),
    version: z
      .object({
        id: z.number(),
        entity: z.string(),
        entity_id: z.number(),
        version: z.number(),
        reason: z.string(),
        snapshot: recordSchema,
        created_at: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const validatorRunSchema = z
  .object({
    id: z.number(),
    q_type: z.string(),
    section_type: z.string().nullable(),
    status: z.string(),
    score: z.number().nullable(),
    failure_reasons: z.array(z.string()),
    meta: recordSchema,
    created_at: z.string(),
  })
  .passthrough();

export const contentVersionSchema = z
  .object({
    id: z.number(),
    entity: z.string(),
    entity_id: z.number(),
    version: z.number(),
    reason: z.string(),
    snapshot: recordSchema,
    created_at: z.string(),
  })
  .passthrough();

export const scheduledTaskSchema = z
  .object({
    id: z.number(),
    key: z.string(),
    label: z.string(),
    task_type: z.string(),
    cadence_s: z.number(),
    status: z.string(),
    enabled: z.boolean(),
    last_run_at: z.string().nullable(),
    next_run_at: z.string().nullable(),
    payload: recordSchema,
    updated_at: z.string(),
  })
  .passthrough();

export const scheduledTasksSchema = z
  .object({
    count: z.number(),
    tasks: z.array(scheduledTaskSchema),
  })
  .passthrough();

export const scheduledTaskRunResultSchema = z
  .object({
    ok: z.boolean(),
    run_id: z.number().optional(),
    task: scheduledTaskSchema.optional(),
    duration_ms: z.number().optional(),
    result: recordSchema.optional(),
    error: z.string().nullable().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const attemptRationaleSchema = z
  .object({
    id: z.number(),
    attempt_id: z.number(),
    question_id: z.number(),
    stage: z.string(),
    answer: z.string().nullable().optional(),
    confidence: z.string().nullable().optional(),
    rationale_text: z.string(),
    trap_guess: z.string().nullable().optional(),
    created_at: z.string(),
  })
  .passthrough();

const whyLoopStepSchema = z
  .object({
    key: z.string(),
    complete: z.boolean(),
    value: z.unknown().optional(),
  })
  .passthrough();

export const whyLoopSchema = z
  .object({
    attempt_id: z.number(),
    question_id: z.number(),
    q_type: z.string().nullable().optional(),
    mode: z.string(),
    answer_key_hidden: z.boolean(),
    next_step: z.string(),
    steps: z.array(whyLoopStepSchema),
    rationales: z.array(
      z
        .object({
          id: z.number(),
          stage: z.string(),
          answer: z.string().nullable().optional(),
          confidence: z.string().nullable().optional(),
          trap_guess: z.string().nullable().optional(),
          created_at: z.string(),
        })
        .passthrough(),
    ),
    local_evidence: recordSchema,
  })
  .passthrough();

export const conceptCardsResultSchema = z
  .object({
    created: z.number(),
    skipped: z.number(),
    origin: z.string().optional(),
    card_id: z.number().nullable().optional(),
    reason: z.string(),
  })
  .passthrough();

const tutorSocraticContextSchema = z
  .object({
    answer_key_hidden: z.boolean(),
    prior_turn_count: z.number(),
    recent_turns: z
      .array(
        z
          .object({
            role: z.string(),
            content: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    similar_misses: z
      .array(
        z
          .object({
            question_id: z.number(),
            attempt_id: z.number().nullable().optional(),
            q_type: z.string().nullable().optional(),
            matched_by: z.string().nullable().optional(),
            similarity: z.number().nullable().optional(),
            trap_type: z.string().nullable().optional(),
            trap_guess: z.string().nullable().optional(),
            chosen_answer: z.string().nullable().optional(),
            note_excerpt: z.string().nullable().optional(),
            rationale_excerpt: z.string().nullable().optional(),
            created_at: z.string().nullable().optional(),
            missed_at: z.string().nullable().optional(),
            source: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    question_context: z
      .object({
        question_id: z.number(),
        attempt_id: z.number().nullable().optional(),
        q_type: z.string().nullable().optional(),
        section_type: z.string().nullable().optional(),
        stem_excerpt: z.string().nullable().optional(),
        prompt_excerpt: z.string().nullable().optional(),
        selected_answer: z.string().nullable().optional(),
        trap_guess: z.string().nullable().optional(),
        passage_id: z.number().nullable().optional(),
        passage_topic: z.string().nullable().optional(),
        passage_excerpt: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    notebook_context: z
      .object({
        count: z.number(),
        notes: z.array(z.string()).optional(),
        items: z
          .array(
            z
              .object({
                kind: z.string(),
                id: z.number(),
                title: z.string(),
                excerpt: z.string().nullable().optional(),
                source: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .optional(),
        refs: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const tutorTurnMetaSchema = z
  .object({
    socratic_context: tutorSocraticContextSchema.optional(),
  })
  .catchall(z.unknown());

export const tutorTurnSchema = z
  .object({
    id: z.number(),
    conversation_id: z.number(),
    role: z.string(),
    content: z.string(),
    meta: tutorTurnMetaSchema,
    created_at: z.string(),
  })
  .passthrough();

export const tutorConversationSchema = z
  .object({
    id: z.number(),
    question_id: z.number(),
    attempt_id: z.number().nullable(),
    mode: z.string(),
    title: z.string(),
    turns: z.array(tutorTurnSchema),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const tutorTurnResultSchema = z
  .object({
    turn: tutorTurnSchema,
    reply: tutorTurnSchema.nullable(),
  })
  .passthrough();

/**
 * Validate `data` against `schema`, attributing failures to `path`. On success
 * returns the parsed value; on failure throws {@link ApiValidationError} so the
 * existing ErrorBoundary surfaces it rather than letting a malformed payload
 * propagate into render.
 */
export function validateResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  path: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiValidationError(path, result.error.issues);
  }
  return result.data;
}
