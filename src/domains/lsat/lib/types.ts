// Types mirroring docs/05-api-contract.md. Backend is the source of truth; if
// OpenAPI diverges, update these.

export type SectionType = "LR" | "RC";
export type QuestionSource =
  | "official"
  | "ai_generated"
  | "sample"
  | "research"
  | "reclor";
export type AttemptMode = "timed" | "blind_review" | "drill";
export type SessionType = "section" | "full_exam" | "drill" | "review";
export type Confidence = "sure" | "likely" | "guess";
export type ErrorReason =
  | "misread"
  | "trap"
  | "concept"
  | "timing"
  | "careless";

export type LrType =
  | "MainPoint"
  | "NecessaryAssumption"
  | "SufficientAssumption"
  | "Strengthen"
  | "Weaken"
  | "Flaw"
  | "Inference"
  | "MostStronglySupported"
  | "PrincipleApply"
  | "PrincipleIdentify"
  | "Parallel"
  | "ParallelFlaw"
  | "Method"
  | "Role"
  | "PointAtIssue"
  | "Paradox"
  | "Evaluate";

export type RcType =
  | "MainPoint"
  | "Attitude"
  | "Detail"
  | "Inference"
  | "Function"
  | "Structure"
  | "Application"
  | "StrengthenWeaken"
  | "Comparative";

export type QType = LrType | RcType | string;

export type TrapType =
  | "reversal"
  | "out_of_scope"
  | "degree"
  | "scope_shift"
  | "half_right"
  | "opposite"
  | "too_strong"
  | "irrelevant_comparison"
  | "premise_restatement"
  | "none";

export type Outcome = "timed_ok" | "timing_problem" | "concept_gap" | "lucky";
export type Trend = "up" | "down" | "flat" | string;

export interface Choice {
  id: number;
  label: string;
  text: string;
  // Present only in review form
  is_correct?: boolean;
  trap_type?: TrapType;
}

export interface Explanation {
  body: string;
  per_choice: Record<string, string>;
  source: string;
}

export interface Question {
  id: number;
  section_id: number | null;
  passage_id: number | null;
  prompt: string;
  stem: string;
  q_type: QType;
  difficulty: number;
  source: QuestionSource;
  choices: Choice[];
  // Review form additions
  correct_answer?: string;
  explanation?: Explanation;
  /** Wave 1.6 — user-flagged "training corpus" provenance, additive. */
  training_eligible?: boolean | null;
  training_role?: string | null;
  training_notes?: string | null;
}

export interface Passage {
  id: number;
  text: string;
  type: SectionType;
  topic?: string;
}

export interface SectionSummary {
  id: number;
  type: SectionType;
  order: number;
  time_limit_sec: number;
  question_count: number;
}

export interface SectionDetail {
  id: number;
  preptest_id: number;
  type: SectionType;
  time_limit_sec: number;
  passages: Passage[];
  questions: Question[];
}

export interface PrepTestSummary {
  id: number;
  name: string;
  source: QuestionSource;
  date_admin: string | null;
  is_official: boolean;
  section_count: number;
  completed_sections: number;
}

export interface PrepTestDetail extends PrepTestSummary {
  sections: SectionSummary[];
}

// AI
export interface AiHealth {
  ollama: boolean;
  models: string[];
  explain_model: string;
  gen_model: string;
  /** Generic active-local-provider status (added with LMStudio support). */
  ok?: boolean;
  provider?: string; // active local provider: "ollama" | "lmstudio"
  local_provider?: string;
  lmstudio_url?: string;
  // Other configured model roles (so the routing card can offer pickers).
  diagnose_model?: string;
  embed_model?: string;
  critic_model?: string;
  /**
   * Configured model ids the active provider does NOT currently list — i.e.
   * roles that will fail at call time until a loaded model is selected. Common
   * right after switching to LMStudio, whose ids differ from Ollama tags.
   */
  missing_models?: string[];
}

export interface Recommendation {
  label: string;
  action: { type: string; payload?: Record<string, unknown> };
}

export interface Diagnosis {
  text: string;
  recommendation: Recommendation;
}

// Sessions & attempts
export interface Session {
  id: number;
  type: SessionType;
  started: string;
}

export interface CreateAttemptBody {
  question_id: number;
  mode: AttemptMode;
  chosen_answer: string | null;
  time_ms: number;
  flagged: boolean;
  confidence?: Confidence;
}

export interface FinishResult {
  scaled_score?: number;
  raw_correct: number;
  total: number;
}

export interface AttemptInfo {
  attempt_id: number;
  chosen_answer: string | null;
  br_answer: string | null;
  is_correct: boolean;
  br_correct: boolean | null;
  time_ms: number;
  flagged?: boolean;
  confidence?: Confidence | null;
  outcome: Outcome;
}

export interface ResultItem {
  question: Question; // review form
  attempt: AttemptInfo;
}

export interface SessionResults {
  session: Session;
  items: ResultItem[];
}

// Analytics
export interface TrendPoint {
  date: string;
  score: number;
}

export interface WeakType {
  q_type: QType;
  accuracy: number;
  avg_time_ms: number;
  trend: Trend;
  section_type?: SectionType;
}

export interface DashboardAnalytics {
  predicted_score: number | null;
  score_delta_30d: number | null;
  trend: TrendPoint[];
  weakest_types: WeakType[];
  coach: { text: string; recommendation: Recommendation };
  streak_days: number;
}

export interface ByTypeRow {
  q_type: QType;
  section_type: SectionType;
  attempts: number;
  accuracy: number;
  avg_time_ms: number;
  trend: Trend;
}

export interface TimingRow {
  question_order: number;
  time_ms: number;
  is_correct: boolean;
  difficulty: number;
}

export interface BlindReviewGap {
  timed_accuracy: number;
  br_accuracy: number;
  gap: number;
  by_type: { q_type: QType; timed_accuracy: number; br_accuracy: number }[];
}

export interface TrapRow {
  trap_type: TrapType;
  times_fell_for: number;
  pct: number;
}

export interface DifficultyRow {
  difficulty: number; // 1-5
  attempts: number;
  accuracy: number;
  avg_time_ms: number;
}

export interface ActivityDay {
  date: string;
  questions: number;
  minutes: number;
  correct: number;
  sessions: number;
}

// Session list (GET /api/sessions) — most-recent-first. Enriched (H8).
export interface SessionSummary {
  id: number;
  type: SessionType;
  started: string;
  ended: string | null;
  scaled_score: number | null;
  question_count: number;
  duration_sec?: number | null;
  br_accuracy?: number | null;
  official_only_score?: number | null;
}

// Bank (research dataset import / stats) — shared so the api client doesn't
// inline these shapes (5.1 reconciliation).
export interface BankStats {
  total: number;
  by_source: Record<string, number>;
  by_q_type: Record<string, number>;
  available_sources: string[];
}

export interface BankSource {
  key: string;
  hf_dataset: string;
  hf_split: string;
  section_type: string;
  preptest_name: string;
  license?: string;
  expected_fields?: string[];
  /** Which QuestionSource bucket inserted rows land in. ReClor sets this to
   * "reclor" so a commercial build can filter the source out wholesale. */
  question_source?: string;
  /** Some sources (ReClor) cannot be auto-fetched; the user must provide a
   * local file path that the backend reads directly. */
  requires_local_path?: boolean;
  /** ReClor's license is non-commercial / personal research only — the
   * importer refuses to run without an explicit acknowledgement. */
  requires_nc_acknowledgement?: boolean;
}

// SRS
export interface SrsCard extends Question {
  card_id: number;
  /**
   * Why the card entered the review queue, e.g. "concept_gap" | "lucky" |
   * "timing_problem" | "manual". Additive on the wire; older payloads omit it.
   */
  origin?: string | null;
  /**
   * Optional per-rating interval preview (days), keyed by rating value as a
   * string ("1".."4"). Present only if the backend precomputes it on the due
   * payload; otherwise the UI shows the realized interval after a rating.
   */
  predicted_intervals?: Record<string, number> | null;
}

export interface SrsDue {
  due_count: number;
  cards: SrsCard[];
  ability_selector?: AbilitySelector;
  utility_model?: string;
  review_strategy?: {
    ordering?: string;
    selector_strategy?: string | null;
    target_difficulty?: number | null;
    srs_due?: number | null;
    utility_model?: string | null;
    utility_score?: number | null;
    srs_pressure?: number | null;
  };
}

export interface SrsReviewResult {
  next_due: string;
  interval_days: number;
  /**
   * Optional per-rating interval preview (days) the backend may return so the
   * UI can label the Again/Hard/Good/Easy buttons before the user commits. Keys
   * are the rating value as a string ("1".."4"). Omitted by older backends.
   */
  predicted_intervals?: Record<string, number> | null;
}

// Playlists / Smart sets (R7 6.1)
export interface PlaylistSummary {
  id: number;
  name: string;
  /** "smart" (criteria-resolved) or "manual" (fixed question ids). */
  kind: string;
  /** Live resolved question count (smart sets re-resolve server-side). */
  count: number;
  criteria?: Record<string, unknown> | null;
  /** Convenience list of which criteria keys are set (from GET /api/playlists). */
  criteria_keys?: string[];
  question_ids?: number[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlaylistDetail extends PlaylistSummary {
  questions?: Question[];
}

/** POST /api/playlists/{id}/play — same shape as POST /api/drills. */
export interface PlaylistPlayResult {
  session_id: number;
  questions: Question[];
}

// Drills
export interface DrillConfig {
  q_type?: QType;
  section_type?: SectionType;
  difficulty?: number;
  count: number;
  source: "real" | "ai" | "any";
  timed: boolean;
}

export interface DrillResult {
  session_id: number;
  questions: Question[];
  ability_selector?: AbilitySelector | null;
  utility_model?: string;
  selection?: {
    utility_model?: string;
    explicit_difficulty?: boolean;
    target_difficulty?: number | null;
    selector_strategy?: string | null;
    selector_utility_model?: string | null;
    utility_score?: number | null;
    zpd?: AbilitySelector["zpd"] | null;
    recent_exclusion_days?: number;
    source?: string;
    origin?: string | null;
    near_misses?: boolean;
  };
}

// vNext — adaptive tutor/readiness contracts
export interface AbilityEstimate {
  q_type: QType | null;
  section_type: SectionType | null;
  ability: number;
  mastery: number;
  uncertainty: number;
  evidence_n: number;
  accuracy: number | null;
  avg_time_ms: number | null;
  components: Record<string, unknown>;
  snapshot_id?: number;
  created_at?: string;
}

export interface AbilityMatrix {
  overall: AbilityEstimate;
  by_type: AbilityEstimate[];
  weakest: AbilityEstimate[];
  selector?: AbilitySelector;
}

export interface AbilitySelector {
  model: string;
  theta: number;
  q_type?: string | null;
  section_type?: SectionType | string | null;
  days?: number | null;
  zpd: {
    target_difficulty: number;
    lower_difficulty: number;
    upper_difficulty: number;
    target_success_window: number[];
  };
  srs: {
    total: number;
    due: number;
    concept_gap: number;
    leech: number;
  };
  strategy: string;
  utility_model?: string;
  utility_weights: Record<string, number>;
  utility?: AbilityUtilityPacket;
  evidence: Record<string, unknown>;
  ability: AbilityEstimate;
}

export interface AbilityUtilityPacket {
  model: string;
  days?: number | null;
  weights: Record<string, number>;
  score: number;
  signals: {
    theta?: number;
    mastery?: number;
    mastery_gap?: number;
    uncertainty?: number;
    uncertainty_pressure?: number;
    evidence_n?: number;
    cadence_pressure?: number;
    mastery_slope_per_week?: number;
    slope_pressure?: number;
    plateau?: boolean;
    srs_due?: number;
    srs_total?: number;
    srs_pressure?: number;
    blind_review_pressure?: number;
    fatigue_pressure?: number;
    [key: string]: unknown;
  };
  cadence?: Record<string, unknown>;
}

export interface FeedbackBucket {
  total: number;
  complete: number;
  skip: number;
  reopen: number;
  completion_rate?: number | null;
  skip_rate?: number | null;
  reopen_rate?: number | null;
  minutes_completed?: number;
  avg_utility_score?: number | null;
  selector_adjustment?: number | null;
  status?: string | null;
  latest_at?: string | null;
}

export interface FeedbackSelectorPolicy {
  model?: string;
  window_days?: number | null;
  base_multiplier?: number;
  drill_sequence_multiplier?: number;
  selector_adjustment?: number | null;
  sequencing_hint?: string | null;
  evidence_events?: number;
  accepted_events?: number;
  skipped_events?: number;
  status?: string | null;
}

export interface FeedbackOutcomeEvidence {
  model?: string;
  status?: string | null;
  accepted_feedback_events?: number;
  attempts_after_acceptance?: number;
  correct_after_acceptance?: number;
  accuracy_after_acceptance?: number | null;
  avg_time_ms_after_acceptance?: number | null;
  baseline_attempts?: number;
  baseline_accuracy?: number | null;
  delta_accuracy?: number | null;
  first_accepted_at?: string | null;
  latest_attempt_at?: string | null;
  q_types_with_outcomes?: number;
}

export interface FeedbackOutcomeCohort {
  q_type: string;
  action: "complete" | "skip" | string;
  feedback_events: number;
  first_feedback_at?: string | null;
  latest_feedback_at?: string | null;
  status: string;
  outcome_attempts: number;
  correct_outcomes: number;
  outcome_accuracy?: number | null;
  avg_time_ms?: number | null;
  baseline_attempts: number;
  baseline_accuracy?: number | null;
  delta_accuracy?: number | null;
  outcome_window_days?: number | null;
  min_attempts: number;
  outcome_min_met: boolean;
  baseline_min_met: boolean;
  planner_weight_eligible: boolean;
  latest_attempt_at?: string | null;
}

export interface FeedbackOutcomeSummary {
  model: string;
  feedback_window_days: number | null;
  outcome_window_days: number;
  source: "official" | "all" | string;
  min_attempts: number;
  generated_at: string;
  total_feedback_events_seen: number;
  qualifying_feedback_events: number;
  cohorts: FeedbackOutcomeCohort[];
  by_q_type: Record<
    string,
    {
      q_type: string;
      actions: Record<string, FeedbackOutcomeCohort>;
      planner_weight_eligible: boolean;
    }
  >;
  summary: {
    status: string;
    cohort_count: number;
    planner_ready_cohorts: number;
    best_lift_q_type?: string | null;
    best_lift_action?: string | null;
    best_lift_delta?: number | null;
  };
}

export interface FeedbackQTypeCohort extends FeedbackBucket {
  q_type: string;
  drill_sequence_multiplier: number;
  sequencing_hint: string;
  rank_score: number;
  selector_policy?: FeedbackSelectorPolicy | null;
  outcome_evidence?: FeedbackOutcomeEvidence | null;
}

export interface FeedbackTaskTypeCohort extends FeedbackBucket {
  task_type: string;
}

export interface FeedbackCohortSummary extends FeedbackBucket {
  model: string;
  window_days: number | null;
  generated_at: string;
  total_events_seen: number;
  by_q_type: Record<string, FeedbackBucket>;
  by_task_type: Record<string, FeedbackBucket>;
  outcome_evidence?: FeedbackOutcomeEvidence | null;
  q_type_cohorts: FeedbackQTypeCohort[];
  task_type_cohorts: FeedbackTaskTypeCohort[];
  top_q_type?: FeedbackQTypeCohort | null;
}

export interface AdaptivityRecommendation {
  question_id: number;
  q_type: QType;
  difficulty: number;
  difficulty_estimate: number;
  expected_success: number;
  information_score: number;
  raw_information?: number;
  utility_score?: number;
  zpd_fit?: number;
  selector_strategy?: string | null;
  reason: string;
  source: QuestionSource | string;
  question: Question;
}

export interface AdaptivityNext {
  ability: AbilityEstimate;
  selector?: AbilitySelector;
  count: number;
  recommendations: AdaptivityRecommendation[];
  guardrails: Record<string, unknown>;
}

export interface AdaptivityPlanTask {
  kind: string;
  label: string;
  minutes: number;
  count?: number;
  q_type?: QType;
  utility?: number;
  utility_model?: string | null;
  feedback_evidence?: TaskFeedbackEvidence;
  target_difficulty?: number;
  why: string;
}

export interface AdaptivityPlan {
  minutes: number;
  ability: AbilityEstimate;
  ability_selector?: AbilitySelector;
  weakest: AbilityEstimate[];
  tasks: AdaptivityPlanTask[];
  utility_model?: string;
  utility?: AbilityUtilityPacket;
}

export interface ExamReadinessCheck {
  key: string;
  label: string;
  status: "ok" | "watch" | "blocker" | string;
  ok: boolean;
  detail: string;
  value?: unknown;
  threshold?: string | null;
  action?: string | null;
}

export interface ExamReadinessSimulation {
  model: string;
  exam_ready: boolean;
  status: "ready" | "at_risk" | "not_ready" | "setup_needed" | string;
  target_score?: number | null;
  exam_date?: string | null;
  horizon_days?: number | null;
  current_score?: number | null;
  projected_score?: number | null;
  readiness_score: number;
  checks: ExamReadinessCheck[];
  blockers: ExamReadinessCheck[];
  warnings: ExamReadinessCheck[];
  summary: string;
}

export interface ReadinessStatus {
  section_type: SectionType | null;
  readiness_score: number;
  status: "ready" | "building" | "needs_foundation" | string;
  on_track: boolean | null;
  exam_ready?: boolean;
  predicted_scaled_score: number | null;
  components: {
    mastery: number;
    accuracy: number | null;
    blind_review_control: number;
    evidence: number;
    srs_load: number;
    attempts_90d: number;
    evidence_days?: number | null;
    ability_days?: number | null;
    due_srs: number;
    learning_velocity?: Record<string, unknown>;
    gap_to_target?: number | null;
    days_to_exam?: number | null;
    zpd_target_difficulty?: number;
    ability_selector_model?: string;
    utility_model?: string;
    utility_score?: number;
    exam_ready?: boolean;
    exam_simulation_status?: string;
  };
  ability: AbilityEstimate;
  ability_selector?: AbilitySelector;
  utility?: AbilityUtilityPacket;
  exam_simulation?: ExamReadinessSimulation;
  snapshot_id?: number;
  created_at?: string;
}

export interface ContentRevalidationTarget {
  question_id: number;
  q_type: string;
  section_type: SectionType | string | null;
  source: string;
  content_fingerprint: string;
  latest_run_id?: number | null;
  latest_status?: string | null;
  latest_created_at?: string | null;
  needs_revalidation: boolean;
  reasons: string[];
  choice_count: number;
  has_passage: boolean;
  updated_at?: string | null;
}

export interface ContentRevalidationReport {
  approved_ai_count: number;
  due_count: number;
  failed_count: number;
  rc_count: number;
  missing_evidence_count: number;
  queue: ContentRevalidationTarget[];
  recent_failures: ContentRevalidationTarget[];
  lookback: number;
  mode: string;
}

export interface ContentRevalidationRunResult {
  ok: boolean;
  validated: number;
  passed: number;
  failed: number;
  quarantined: number;
  quarantined_question_ids: number[];
  model_gate: boolean;
  apply_quarantine: boolean;
  force: boolean;
  runs: {
    question_id: number;
    validator_run_id: number;
    status: string;
    score: number | null;
    failure_reasons: string[];
    model_gate: boolean;
    quarantined: boolean;
  }[];
  remaining: ContentRevalidationReport;
}

export interface ContentRevalidationRemediationResult {
  ok: boolean;
  action: string;
  question_id: number;
  validator_run_id?: number | null;
  version: ContentVersionRecord;
  question: {
    id: number;
    approved: boolean;
    quarantined: boolean;
    updated_at?: string | null;
  };
  remaining: ContentRevalidationReport;
}

export interface ContentDuplicateRemediationResult {
  ok: boolean;
  action: string;
  cluster_key: string;
  duplicate_kind?: string | null;
  canonical_question_id: number;
  quarantined_question_ids: number[];
  versions: ContentVersionRecord[];
  remaining: Record<string, unknown>;
}

export interface ContentHealth {
  total_questions: number;
  score: number;
  status: "ok" | "warning" | string;
  warnings: string[];
  by_source: Record<string, number>;
  by_q_type: Record<string, number>;
  tag_confidence: { low: number; low_question_ids: number[] };
  quarantine: { count: number; question_ids: number[] };
  duplicates: {
    clusters: {
      content_hash: string;
      cluster_key?: string;
      duplicate_kind?: string;
      count: number;
      question_ids?: number[];
      recommended_canonical_id?: number | null;
      quarantine_candidate_ids?: number[];
      source_mix?: Record<string, number>;
      q_type_mix?: Record<string, number>;
      sample?: string;
    }[];
    cluster_count: number;
  };
  official_firewall: {
    ok: boolean;
    training_eligible_official_count: number;
    question_ids: number[];
    notebook_violations?: {
      artifact_ids?: number[];
      source_ids?: number[];
      transformation_ids?: number[];
      podcast_ids?: number[];
    };
  };
  validator_coverage: {
    ai_without_validator_count: number;
    ai_without_validator_question_ids: number[];
    known_validator_types: string[];
  };
  choice_integrity: { nonstandard_choice_count: number; question_ids: number[] };
  index_health?: Record<string, { status?: string; detail?: Record<string, unknown> }>;
  versioning: { snapshots: number; by_entity: Record<string, number> };
  provenance_score?: {
    score: number;
    status: "ok" | "warning" | "blocked" | string;
    summary: string;
    blocked_source_keys: string[];
    warning_source_keys: string[];
    sources: {
      key: string;
      label: string;
      source_type: string;
      license?: string | null;
      question_count: number;
      score: number;
      status: "ok" | "warning" | "blocked" | string;
      reasons: string[];
      eligibility: Record<string, unknown>;
      firewall: Record<string, unknown>;
      seeded_from?: string | null;
      quality: Record<string, number>;
    }[];
  };
  source_registry?: {
    count: number;
    sources: {
      key: string;
      label: string;
      source_type: string;
      license?: string | null;
      eligibility: Record<string, unknown>;
      firewall: Record<string, unknown>;
    }[];
  };
  validator_runs?: {
    recent_count: number;
    failure_reasons: Record<string, number>;
    recent: {
      id: number;
      q_type: string;
      section_type: SectionType | string | null;
      status: string;
      score: number | null;
      failure_reasons: string[];
      meta?: ValidatorRunMeta;
      created_at: string;
    }[];
  };
  revalidation?: ContentRevalidationReport;
}

export interface ReleaseTrustCheck {
  status: "ok" | "warn" | "block" | string;
  summary: string;
  detail: Record<string, unknown>;
  action?: string | null;
}

export interface ReleaseTrustManifest {
  schema: string;
  tier: "dev" | "release" | "packaged" | string;
  status: "ok" | "warning" | "blocked" | string;
  score: number;
  generated_at: string;
  app_version: string;
  environment: Record<string, unknown>;
  checks: Record<string, ReleaseTrustCheck>;
  blockers: { check: string; summary: string; action?: string | null }[];
  warnings: { check: string; summary: string; action?: string | null }[];
  next_actions: string[];
  snapshot_id?: number;
  written_to?: string;
}

export interface NotebookLink {
  id: number;
  question_id: number;
  attempt_id: number | null;
  label: string;
  note: string;
  q_type?: QType | null;
  source?: string | null;
  created_at: string;
}

export interface NotebookPage {
  id: number;
  title: string;
  slug: string;
  body: string;
  summary: string;
  tags: string[];
  links: NotebookLink[];
  created_at: string;
  updated_at: string;
}

export type ContextMode =
  | "off"
  | "summary"
  | "full"
  | "answer_key_locked"
  | "after_reveal"
  | "official_firewalled"
  | string;

export interface WorkspaceManifest {
  id: number;
  key: string;
  title: string;
  description: string;
  home_artifact_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRef {
  id?: number;
  artifact_id?: number;
  kind: string;
  entity_id: string;
  target: string;
  quote?: string;
  range?: Record<string, unknown>;
  line_ref?: string | null;
  reveal_state?: string;
  official_firewall?: boolean;
  label?: string;
  meta?: Record<string, unknown>;
  created_at?: string;
}

export interface CitationTarget {
  id?: number;
  artifact_id?: number | null;
  target: string;
  target_kind?: string;
  kind?: string;
  entity_id?: string;
  exists?: boolean;
  label: string;
  snippet?: string;
  official_firewall: boolean;
  cloud_allowed?: boolean;
  export_eligible?: boolean;
  created_at?: string;
}

export interface StudyArtifact {
  id: number;
  workspace_id?: number | null;
  kind: string;
  title: string;
  body: string;
  summary: string;
  source_kind: string;
  q_type?: string | null;
  question_id?: number | null;
  attempt_id?: number | null;
  passage_id?: number | null;
  visibility: string;
  official_firewall: boolean;
  cloud_allowed: boolean;
  export_eligible: boolean;
  tags: string[];
  meta: Record<string, unknown>;
  evidence_refs?: EvidenceRef[];
  citations?: CitationTarget[];
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersion {
  id: number;
  artifact_id: number;
  version: number;
  reason: string;
  snapshot: Partial<StudyArtifact> & Record<string, unknown>;
  created_at: string;
}

export interface BacklinkRecord {
  id: number;
  source_artifact_id?: number | null;
  source_title: string;
  source_kind: string;
  source_summary: string;
  source_official_firewall: boolean;
  target_ref: string;
  relation: string;
  q_type?: string | null;
  trap?: string | null;
  role?: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface CaptureRequest {
  workspace_id?: number | null;
  kind?: string;
  title: string;
  body?: string;
  summary?: string;
  source_kind?: string;
  refs?: Array<string | Record<string, unknown>>;
  tags?: string[];
  q_type?: string | null;
  question_id?: number | null;
  attempt_id?: number | null;
  passage_id?: number | null;
  official_firewall?: boolean;
  cloud_allowed?: boolean;
  export_eligible?: boolean;
  meta?: Record<string, unknown>;
}

export interface NotebookSource {
  id: number;
  workspace_id?: number | null;
  artifact_id?: number | null;
  title: string;
  source_type: string;
  status: string;
  content_type: string;
  provider: string;
  official_firewall: boolean;
  processing: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NotebookImportRequest {
  title: string;
  source_registry_key?: string;
  source_key?: string;
  source_type?: string;
  content_type?: string;
  content?: string;
  url?: string;
  provider?: string;
  refs?: Array<string | Record<string, unknown>>;
  tags?: string[];
  official_firewall?: boolean;
  file?: File | null;
}

export interface NotebookExportBundle {
  title: string;
  format: "markdown" | "html" | "json";
  content_type: string;
  body: string | Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  redacted_count: number;
}

export interface NotebookImportBundleResult {
  schema: string;
  title: string;
  format: "json" | "markdown" | "html";
  created: {
    sources: number;
    notes: number;
    artifacts: number;
  };
  created_refs: string[];
  skipped: Array<Record<string, unknown>>;
  firewall_decision: Record<string, unknown>;
}

export interface NotebookCapabilityOption {
  value: string;
  label: string;
  description?: string | null;
  enabled?: boolean;
}

export interface NotebookContextModeCapability extends NotebookCapabilityOption {
  value: ContextMode;
  icon?: string | null;
}

export interface NotebookExportFormatCapability extends NotebookCapabilityOption {
  value: NotebookExportBundle["format"];
  content_type?: string | null;
}

export interface NotebookCapabilities {
  source_types: NotebookCapabilityOption[];
  note_types: NotebookCapabilityOption[];
  transform_templates: NotebookCapabilityOption[];
  export_formats: NotebookExportFormatCapability[];
  import_formats?: NotebookCapabilityOption[];
  context_modes: NotebookContextModeCapability[];
}

export interface NotebookNote {
  id: number;
  workspace_id?: number | null;
  artifact_id?: number | null;
  note_type: string;
  title: string;
  content: string;
  citations: Array<string | Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

export interface NotebookChatSession {
  id: number;
  workspace_id?: number | null;
  title: string;
  mode: ContextMode;
  model: string;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NotebookChatMessage {
  id: number;
  session_id: number;
  role: "user" | "assistant" | string;
  content: string;
  citations: Array<string | Record<string, unknown>>;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface NotebookChatTurnResult {
  user: NotebookChatMessage;
  assistant: NotebookChatMessage;
  firewall_decision: Record<string, unknown>;
}

export interface NotebookSearchResult {
  query: string;
  artifacts: StudyArtifact[];
  notes: NotebookNote[];
  sources: NotebookSource[];
  artifact_search?: {
    mode: string;
    fallback_used: boolean;
    fallback_reason?: string;
    fts_count?: number;
    fallback_count?: number;
  };
}

export interface TransformationRun {
  id: number;
  workspace_id?: number | null;
  template_key: string;
  status: string;
  prompt: string;
  input_refs: Array<string | Record<string, unknown>>;
  output_artifact_id?: number | null;
  provider: string;
  model: string;
  firewall_decision: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PodcastEpisode {
  id: number;
  workspace_id?: number | null;
  title: string;
  episode_type: string;
  status: string;
  transcript: string;
  audio_path?: string | null;
  source_refs: Array<string | Record<string, unknown>>;
  provider: string;
  firewall_decision: Record<string, unknown>;
  duration_sec?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityEvent {
  id: number;
  kind: string;
  status: string;
  title: string;
  detail: Record<string, unknown>;
  entity: string;
  entity_id?: number | null;
  progress_pct: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeInboxItem {
  id: number;
  artifact_id?: number | null;
  artifact_title: string;
  origin: string;
  status: string;
  priority: number;
  reason: string;
  created_at: string;
  resolved_at?: string | null;
}

export interface ContextPreset {
  id: number;
  workspace_id?: number | null;
  name: string;
  modes: Record<string, unknown>;
  policy: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RCPassageMap {
  analysis_id?: number;
  passage_id: number;
  topic?: string | null;
  structure: {
    paragraph_count: number;
    passage_type: string;
    topic?: string | null;
    main_point_hint: string;
    question_mix: Record<string, number>;
    line_reference_density: number;
    viewpoint_count?: number;
    dominant_viewpoint?: string | null;
    evidence_anchor_count?: number;
    tag_coverage?: {
      tagged_questions: number;
      total_questions: number;
      coverage: number;
      low_confidence: number;
      by_scope: Record<string, number>;
    };
  };
  paragraph_roles: {
    index: number;
    line_ref?: string;
    role: string;
    author_attitude: string;
    claim_density: number;
    viewpoint?: {
      label?: string;
      stance?: string;
      signals?: string[];
    };
    evidence_markers?: string[];
    text_preview: string;
  }[];
  evidence_refs?: {
    paragraph_index?: number;
    line_ref: string;
    marker: string;
    evidence_type: string;
    text_preview: string;
  }[];
  question_tags?: {
    question_id: number;
    q_type: string;
    scope: string;
    anchor_ref?: string;
    requires_evidence?: boolean;
    tags: string[];
    tag_confidence: number;
  }[];
  timing: {
    attempts: number;
    avg_time_ms: number | null;
    accuracy: number | null;
    by_q_type: Record<string, { attempts: number; avg_time_ms: number; accuracy: number }>;
  };
  generated_by: string;
  updated_at: string;
}

export interface RCDashboard {
  passages: number;
  questions: number;
  mapped_passages: number;
  coverage: number;
  by_q_type: Record<string, number>;
  tag_coverage?: {
    tagged_questions: number;
    total_questions: number;
    coverage: number;
    low_confidence: number;
    by_scope: Record<string, number>;
  };
  timing: RCPassageMap["timing"];
  next_actions: string[];
}

export interface ContentSourceRegistry {
  id: number;
  key: string;
  label: string;
  source_type: string;
  license?: string | null;
  eligibility: Record<string, unknown>;
  firewall: Record<string, unknown>;
  updated_at: string;
  policy_review?: SourcePolicyReview;
  version?: ContentVersionRecord;
}

export interface SourcePolicyRisk {
  code: string;
  severity: "warning" | "blocker" | string;
  detail: string;
}

export interface SourcePolicyReview {
  source_key: string;
  question_count: number;
  requires_review: boolean;
  risks: SourcePolicyRisk[];
  acknowledged_risks: string[];
  missing_acknowledgements: string[];
  reviewed: boolean;
  reviewer_note?: string;
}

export interface SourcePolicyUpdate {
  key: string;
  label?: string;
  source_type?: string;
  license?: string | null;
  eligibility?: Record<string, unknown>;
  firewall?: Record<string, unknown>;
  reviewed?: boolean;
  acknowledged_risks?: string[];
  reviewer_note?: string;
  reason?: string;
}

export interface ValidatorRunContext {
  parent_passage_id?: number;
  generated_by?: string | null;
  passage_type?: string | null;
  paragraph_count?: number | null;
  dominant_viewpoint?: string | null;
  evidence_anchor_count?: number | null;
  main_point_hint?: string;
  question_mix?: Record<string, number>;
  line_reference_density?: number | null;
  tag_coverage?: {
    tagged_questions?: number;
    total_questions?: number;
    coverage?: number;
    low_confidence?: number;
    by_scope?: Record<string, number>;
  };
  target_scope?: string | null;
  target_anchor_ref?: string | null;
  target_requires_evidence?: boolean | null;
  target_tags?: string[];
  target_tag_confidence?: number | null;
  paragraph_roles?: {
    index?: number | null;
    line_ref?: string | null;
    role?: string | null;
    attitude?: string | null;
    claim_density?: number | null;
    viewpoint?: {
      label?: string | null;
      stance?: string | null;
      signals?: string[];
    };
    evidence_markers?: string[];
  }[];
  evidence_refs?: {
    line_ref?: string | null;
    marker?: string | null;
    evidence_type?: string | null;
    text_preview?: string | null;
  }[];
}

export interface ValidatorRunMeta extends Record<string, unknown> {
  gen_job_id?: number;
  candidate_index?: number;
  question_id?: number;
  parent_question_id?: number;
  training_anchor_id?: number;
  verdict_reason?: string | null;
  solver_model?: string | null;
  critic_model?: string | null;
  rc_generation_context?: ValidatorRunContext;
}

export interface ValidatorRunRecord {
  id: number;
  q_type: string;
  section_type: SectionType | string | null;
  status: string;
  score: number | null;
  failure_reasons: string[];
  meta: ValidatorRunMeta;
  created_at: string;
}

export interface ContentVersionRecord {
  id: number;
  entity: string;
  entity_id: number;
  version: number;
  reason: string;
  snapshot: Record<string, unknown>;
  created_at: string;
}

export interface ContentVersionFilters {
  entity?: string;
  entity_id?: number;
  reason?: string;
  reason_contains?: string;
  source_key?: string;
  risk_code?: string;
  risk_severity?: string;
  changed_field?: string;
  limit?: number;
}

export interface RestoreContentVersionBody {
  target?: "current" | "previous";
  reviewed?: boolean;
  acknowledged_risks?: string[];
  reviewer_note?: string;
  reason?: string;
}

export interface ScheduledTaskRecord {
  id: number;
  key: string;
  label: string;
  task_type: string;
  cadence_s: number;
  status: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
}

export interface ScheduledTaskRunResult {
  ok: boolean;
  run_id?: number;
  task?: ScheduledTaskRecord;
  duration_ms?: number;
  result?: Record<string, unknown>;
  error?: string | null;
  reason?: string;
}

export interface SchedulerRunRecord {
  id: number;
  task_key: string;
  task_type: string;
  status: string;
  duration_ms: number;
  result: Record<string, unknown>;
  error?: string | null;
  created_at: string;
}

export interface BenchmarkRunRecord {
  id: number;
  kind: string;
  status: string;
  metrics: Record<string, unknown>;
  environment: Record<string, unknown>;
  notes?: string | null;
  created_at: string;
}

export interface MigrationPreview {
  latest_expected_version: number;
  pragma_user_version: number;
  applied_count: number;
  pending_count: number;
  applied: Record<string, unknown>[];
  pending: Record<string, unknown>[];
  failed: Record<string, unknown>[];
  checksum_mismatches: Record<string, unknown>[];
  pre_migration_backup_required: boolean;
  restore_after_upgrade_smoke_required: boolean;
}

export interface WhyLoopState {
  attempt_id: number;
  question_id: number;
  q_type?: string | null;
  mode: string;
  answer_key_hidden: boolean;
  next_step: string;
  steps: { key: string; complete: boolean; value?: unknown }[];
  rationales: {
    id: number;
    stage: string;
    answer?: string | null;
    confidence?: Confidence | null;
    trap_guess?: string | null;
    created_at: string;
  }[];
  local_evidence: Record<string, unknown>;
}

export interface AttemptRationaleRecord {
  id: number;
  attempt_id: number;
  question_id: number;
  stage: string;
  answer?: string | null;
  confidence?: Confidence | null;
  rationale_text: string;
  trap_guess?: string | null;
  created_at: string;
}

export interface ConceptCardsResult {
  created: number;
  skipped: number;
  origin?: string;
  card_id?: number | null;
  reason: string;
}

export interface TutorSimilarMissEvidence {
  attempt_id?: number | null;
  question_id: number;
  q_type?: string | null;
  matched_by?: string | null;
  similarity?: number | null;
  trap_type?: string | null;
  trap_guess?: string | null;
  chosen_answer?: string | null;
  note_excerpt?: string | null;
  rationale_excerpt?: string | null;
  created_at?: string | null;
  missed_at?: string | null;
  source?: string | null;
}

export interface TutorQuestionContext {
  question_id: number;
  attempt_id?: number | null;
  q_type?: string | null;
  section_type?: string | null;
  stem_excerpt?: string | null;
  prompt_excerpt?: string | null;
  selected_answer?: string | null;
  trap_guess?: string | null;
  passage_id?: number | null;
  passage_topic?: string | null;
  passage_excerpt?: string | null;
}

export interface TutorNotebookContextItem {
  kind: string;
  id: number;
  title: string;
  excerpt?: string | null;
  source?: string | null;
}

export interface TutorNotebookContext {
  count: number;
  notes?: string[];
  items?: TutorNotebookContextItem[];
  refs?: unknown[];
}

export interface TutorSocraticContext {
  answer_key_hidden: boolean;
  prior_turn_count: number;
  recent_turns?: { role: string; content: string }[];
  question_context?: TutorQuestionContext;
  similar_misses?: TutorSimilarMissEvidence[];
  notebook_context?: TutorNotebookContext;
}

export interface TutorTurnMeta extends Record<string, unknown> {
  local_only?: boolean;
  model?: string;
  socratic_context?: TutorSocraticContext;
}

export interface TutorTurnRecord {
  id: number;
  conversation_id: number;
  role: "user" | "assistant" | string;
  content: string;
  meta: TutorTurnMeta;
  created_at: string;
}

export interface TutorTurnResult {
  turn: TutorTurnRecord;
  reply: TutorTurnRecord | null;
}

export interface TutorConversation {
  id: number;
  question_id: number;
  attempt_id: number | null;
  mode: string;
  title: string;
  turns: TutorTurnRecord[];
  created_at: string;
  updated_at: string;
}

// LSAT-4 — streaming Socratic tutor (useSocraticStream + socratic_routes).
/** A turn in the live Socratic stream (user prediction or assistant nudge). */
export interface SocraticTurn {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Present on assistant turns: the citable context behind the nudge. */
  context?: TutorSocraticContext;
}

/** An inline citation badge flattened from a turn's Socratic context. */
export interface SocraticCitation {
  kind: "similar_miss" | "notebook";
  label: string;
  detail?: string;
  /** Set for ``similar_miss`` citations. */
  questionId?: number;
  /** Set for ``notebook`` citations. */
  id?: number;
}

/** GET /api/conversations/{id}/evidence — the citable evidence for a conversation. */
export interface SocraticEvidence {
  conversation_id: number;
  question_id: number;
  answer_key_hidden: boolean;
  prior_turn_count: number;
  recent_turns: { role: string; content: string }[];
  question_context: TutorQuestionContext | Record<string, never>;
  similar_misses: TutorSimilarMissEvidence[];
  notebook_context: TutorNotebookContext;
}

/** Done-frame metadata streamed by POST /api/conversations/{id}/turns-stream. */
export interface SocraticTurnStreamDone {
  turn?: TutorTurnRecord;
  reply?: TutorTurnRecord | null;
  socratic_context?: TutorSocraticContext;
}

// Import wizard
export interface ParsedQuestion {
  prompt: string;
  stem: string;
  q_type?: QType;
  difficulty?: number;
  choices: { label: string; text: string; is_correct?: boolean }[];
  correct_answer?: string;
}

export interface ParsedPassage {
  text: string;
  type: SectionType;
  topic?: string;
}

export interface ParsedSection {
  type: SectionType;
  questions: ParsedQuestion[];
  passages: ParsedPassage[];
}

export interface ParsedPrepTest {
  name: string;
  sections: ParsedSection[];
}

export interface ImportParseResult {
  job_id: number | string;
  parsed: ParsedPrepTest;
  warnings: string[];
}

// D1 — import commit integrity gate. POST /api/import/commit returns HTTP 409
// with this body when the parsed structure has missing/invalid answer keys or
// wrong choice counts.
export interface ImportIntegrityIssue {
  kind: string;
  where?: string;
  detail: string;
}

export interface ImportIntegrityError {
  error: "unresolved_integrity_issues";
  issues: ImportIntegrityIssue[];
}

/** POST /api/import/reconcile — compare parsed answers against an official key. */
export interface ReconcileMismatch {
  index: number;
  parsed: string | null;
  key: string | null;
  prompt: string;
}

export interface ImportReconcileResult {
  total_questions: number;
  key_length: number;
  mismatches: ReconcileMismatch[];
  match_count: number;
  applied: boolean;
  parsed: ParsedPrepTest;
}

/** GET /api/import/jobs */
export interface ImportJobSummary {
  job_id: number;
  filename: string;
  committed: boolean;
  preptest_id: number | null;
  warnings: string[];
  created_at: string;
}

/** GET /api/import/jobs/{id} */
export interface ImportJobDetail {
  job_id: number;
  filename: string;
  parsed: ParsedPrepTest;
  warnings: string[];
  committed: boolean;
  preptest_id: number | null;
}

// Error log
export interface ErrorLogEntry {
  id: number;
  question: Question; // review form
  reason: ErrorReason;
  note: string;
  ai_diagnosis?: string;
  created_at: string;
}

// Generation (Tier B)
export interface GenJob {
  id: string;
  status: "planned" | "queued" | "running" | "done" | "failed" | "cancelled";
  produced?: number;
  accepted?: number;
  quarantined?: number;
  priority?: number;
  progress_pct?: number;
  retry_count?: number;
  max_retries?: number;
  retry_pending?: boolean;
  retry_exhausted?: boolean;
  validation_report?: unknown;
}

// ---------------------------------------------------------------------------
// Round 5 additions
// ---------------------------------------------------------------------------

// A5 — cached coach snapshot
export interface CoachSnapshot {
  available: boolean;
  text?: string;
  recommendation?: Recommendation;
  created_at?: string;
}

// B9 — recency/difficulty-adjusted mastery
export interface MasteryRow {
  q_type: QType;
  section_type: SectionType;
  attempts: number;
  mastery: number;
  weighted_accuracy: number;
  recent_accuracy: number;
  avg_difficulty: number;
  trend: Trend;
}

// B2 — score forecast
export interface Forecast {
  current_score: number | null;
  projected_score: number | null;
  slope_per_week: number;
  confidence: { low: number; high: number } | null;
  target_score: number | null;
  gap_to_target: number | null;
  on_track: boolean | null;
  days_to_exam: number | null;
  n_points: number;
}

// C6 — backend silent-regression diagnostics
export interface RegressionAlert {
  q_type: QType | string;
  section_type: SectionType | string;
  recent_attempts: number;
  baseline_attempts: number;
  recent_correct: number;
  baseline_correct: number;
  recent_accuracy: number;
  baseline_accuracy: number;
  delta: number;
  z_score: number | null;
  statistically_significant: boolean;
  severity: "high" | "medium" | "watch" | string;
  reason: string;
}

export interface RegressionAlerts {
  model: string;
  source: "official" | "all" | string;
  recent_days: number;
  baseline_days: number;
  min_attempts: number;
  min_drop: number;
  status: "regression" | "watch" | "ok" | "insufficient_data" | string;
  alerts: RegressionAlert[];
  summary: {
    alert_count: number;
    checked_types: number;
    insufficient_types: number;
    recent_window_start: string;
    baseline_window_start: string;
  };
  insufficient: {
    q_type: QType | string;
    section_type: SectionType | string;
    recent_attempts: number;
    baseline_attempts: number;
  }[];
}

// B15/H4 — single-type deep dive
export interface TypeAnalytics {
  q_type: QType;
  overall: {
    q_type: QType;
    attempts: number;
    accuracy: number;
    avg_time_ms: number;
    trend: Trend;
  };
  by_section: Record<string, { attempts: number; accuracy: number }>;
  gap: { timed_accuracy: number; br_accuracy: number; gap: number; n: number };
  traps: TrapRow[];
  recent_misses: {
    question_id: number;
    chosen_answer: string | null;
    correct_answer: string | null;
    time_ms: number;
    created_at: string;
  }[];
}

// C11 — focus quality
export interface FocusQuality {
  score: number | null;
  components: Record<string, number>;
  n: number;
}

// E1/E2 — study plan + today
export interface StudyPlan {
  has_plan: boolean;
  target_score?: number;
  exam_date?: string | null;
  daily_minutes?: number;
}

export interface NotebookContextMeta {
  count: number;
  notes?: string[];
  items: { kind: string; id: number; title: string; reason: string }[];
  refs?: { kind: string; id: number; title: string; reason: string }[];
}

export interface PlanTask {
  type: string;
  label: string;
  q_type?: QType;
  count?: number;
  accuracy?: number;
  weight?: number | null;
  est_minutes?: number;
  target_difficulty?: number | null;
  selector_strategy?: string | null;
  utility_model?: string;
  selector_utility_model?: string | null;
  utility_score?: number | null;
  feedback_evidence?: TaskFeedbackEvidence;
  notebook_context?: NotebookContextMeta;
}

export interface TaskFeedbackEvidence {
  model?: string;
  total?: number;
  complete?: number;
  skip?: number;
  reopen?: number;
  completion_rate?: number | null;
  skip_rate?: number | null;
  status?: string | null;
  selector_adjustment?: number | null;
  label?: string | null;
  impact?: {
    key: string;
    status: string;
    value?: number;
    detail?: string;
  }[];
}

export interface TodayPlan {
  has_plan: boolean;
  target_score: number | null;
  exam_date: string | null;
  daily_minutes: number | null;
  days_to_exam: number | null;
  predicted_score: number | null;
  forecast: Forecast;
  due_count: number;
  weakest_types: WeakType[];
  tasks: PlanTask[];
  notebook_context?: NotebookContextMeta;
  intensity?: string;
  minutes_budget?: number;
  estimated_minutes?: number;
  leech_count?: number;
  concept_gap_count?: number;
  rationale?: string;
  ability_selector?: AbilitySelector;
  utility_model?: string;
  utility?: AbilityUtilityPacket;
  selector_summary?: {
    target_difficulty?: number | null;
    strategy?: string | null;
    srs_due?: number | null;
    utility_model?: string | null;
    utility_score?: number | null;
    feedback?: Record<string, unknown> | null;
  };
}

export interface TodayPlanFeedbackBody {
  task_id: string;
  task_type?: string;
  task_label?: string;
  action: "complete" | "reopen" | "skip";
  client_day?: string | null;
  minutes?: number | null;
  q_type?: QType | string | null;
  utility_score?: number | null;
  utility_model?: string | null;
  target_difficulty?: number | null;
  tradeoffs?: string[];
}

// H3 — preptest progress
export interface PrepTestProgress {
  preptest_id: number;
  name: string;
  section_count: number;
  sections_done: number;
  sections: {
    section_id: number;
    type: SectionType;
    order: number;
    question_count: number;
    attempted: number;
    done: boolean;
    accuracy: number | null;
    br_accuracy: number | null;
    best_score: number | null;
  }[];
}

// C10 — full exam
export interface ExamSession {
  session_id: number;
  preptest_id: number;
  name: string;
  sections: SectionSummary[];
}

export interface ExamResults {
  session_id: number;
  type: SessionType;
  started: string | null;
  ended: string | null;
  scaled_score: number | null;
  raw_correct: number;
  total: number;
  official_correct: number;
  official_total: number;
  sections: {
    section_id: number | null;
    type: SectionType | null;
    correct: number;
    total: number;
    accuracy: number;
  }[];
}

// E3 — reflection journal
export interface Reflection {
  exists: boolean;
  id?: number;
  session_id: number;
  text: string;
  prompts: string[];
  created_at?: string;
  updated_at?: string;
}

// F3 — bank audit + duplicates
export interface BankAudit {
  total: number;
  by_source: Record<string, number>;
  missing_q_type: number;
  generic_placeholder: number;
  length_tell: number;
  missing_trap_tags: number;
  embedded: number;
}

export interface DuplicateCluster {
  question_ids: number[];
  size: number;
  sample_stem: string;
}

// F6 — generation jobs list / coverage
export interface GenJobSummary {
  id: number;
  status: "planned" | "queued" | "running" | "done" | "failed" | "cancelled";
  q_type: QType;
  count: number;
  produced: number;
  accepted: number;
  quarantined: number;
  priority?: number;
  progress_pct?: number;
  retry_count?: number;
  max_retries?: number;
  retry_pending?: boolean;
  retry_exhausted?: boolean;
  created_at: string;
  updated_at?: string | null;
  cancelled_at?: string | null;
}

export interface CoverageRow {
  q_type: QType;
  servable: number;
  anchors: number;
  quarantined: number;
}

// A11 — quarantine triage
export interface QuarantineTriage {
  question_id: number;
  found: boolean;
  suggested_verdict: "approve" | "reject" | null;
  reason: string | null;
  checks: Record<string, unknown>;
  self_consistency_pass?: boolean;
  parent_question_id?: number | null;
  job_id?: number;
}

// H6/A13 — observability status (trust strip)
export interface ProviderInfo {
  realtime_provider: string;
  local_provider?: string; // "ollama" | "lmstudio"
  lmstudio_url?: string;
  offline_provider: string;
  cloud_enabled: boolean;
  explain_model: string;
  explain_model_configured?: string;
  explain_model_fallback?: string;
  tag_model?: string;
  gen_model: string;
  critic_model?: string;
  diagnose_model: string;
  embed_model: string;
  cloud_gen_model: string | null;
}

export interface ObservabilityStatus {
  gen_queued: number;
  gen_running: number;
  worker_alive: boolean;
  last_coach_refresh_ms: number | null;
  explain_p50_ms: number | null;
  embed_coverage_pct: number;
  models: ProviderInfo;
  backend_ready?: boolean;
  db_ready?: boolean;
  worker_ready?: boolean;
  backup_status?: string;
  readiness?: Record<string, unknown>;
  cloud_spend_mtd_usd?: number;
  cloud_budget_within?: boolean;
  cloud_budget_remaining_usd?: number | null;
  cloud_tokens?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cloud_monthly_budget_usd?: number | null;
}

export interface RuntimeLogEvent {
  timestamp?: string | null;
  level: string;
  request_id?: string | null;
  status?: number | null;
  path?: string | null;
  file: string;
  message: string;
}

export interface RuntimeEvidence {
  ok: boolean;
  status: string;
  generated_at: string;
  log_dir: string;
  log_dir_exists: boolean;
  log_dir_writable: boolean;
  log_file_count: number;
  log_files: {
    name: string;
    path: string;
    readable: boolean;
    size_bytes?: number;
    modified_at?: string;
    error?: string;
  }[];
  recent_error_count: number;
  recent_errors: RuntimeLogEvent[];
  last_request_error?: RuntimeLogEvent | null;
  metrics: Record<string, unknown>;
  crash_free_window: Record<string, unknown>;
}

// C4 — settings
export interface Settings {
  settings: {
    explain_model: string;
    gen_model: string;
    diagnose_model: string;
    embed_model: string;
    gen_provider: string;
    cloud_gen_model: string;
    gen_critic_model?: string; // generation-gate critic (decorrelated from gen_model)
    local_provider?: string; // "ollama" | "lmstudio"
    lmstudio_url?: string;
    // Parity with api.gen.ts SettingsPatch — FSRS desired retention (numeric).
    desired_retention?: number;
  };
  provider: ProviderInfo;
}

// D7/H10 — similar question with score
export interface SimilarQuestion extends Question {
  similarity?: number;
}

// ---------------------------------------------------------------------------
// X2 / D4 — local backups + integrity (Diagnostics panel)
// ---------------------------------------------------------------------------
export interface BackupInfo {
  name: string;
  size_bytes: number;
  created_at: string;
}

/** GET /api/backup/list */
export interface BackupList {
  backups: BackupInfo[];
}

/** GET /api/backup/integrity */
export interface BackupIntegrity {
  result: string;
}

/** POST /api/backup/restore */
export interface BackupRestoreResult {
  restored: boolean;
  restart_recommended: boolean;
}

// ---------------------------------------------------------------------------
// Wave 3/4 — AI quality + feedback (Q1/Q2/Q5), coach chat (X3)
// ---------------------------------------------------------------------------

// Q1 — GET /api/ai/explanation-quality
export interface ExplanationQuality {
  total: number;
  helpful: number;
  unhelpful: number;
  helpful_rate: number;
  low_rated_question_ids: number[];
}

// X3 — POST /api/ai/coach/chat — a single conversational turn.
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Q2 — GET /api/gen/quality
export interface GenQuality {
  jobs: number;
  total_candidates: number;
  passed: number;
  quarantined: number;
  pass_rate: number;
  fail_reasons: Record<string, number>;
  by_type: Record<string, { passed: number; failed: number }>;
  cloud_recommended_types: string[];
}

// Q5 — GET /api/gen/drift
export interface DriftItem {
  question_id: number;
  attempts: number;
  accuracy: number;
}

export interface GenDrift {
  checked: number;
  flagged: DriftItem[];
  min_attempts: number;
  floor: number;
}

// LSAT-6 — Annotation Notebook knowledge base (backlinks + FTS search + inline
// authoring). Wire shapes from services/lsat-backend/app/routers/annotation_kb_routes.py.
export interface Backlink {
  annotation_id: number;
  scope: string;
  ref_id: number;
  /** Canonical ref this annotation links from/to, e.g. "question:42" / "attempt:7". */
  target: string;
  user_explanation: string;
  tags: string[];
  snippet: string;
  updated_at: string | null;
}

export interface AnnotationSearchHit {
  annotation_id: number;
  scope: string;
  ref_id: number;
  target: string;
  user_explanation: string;
  tags: string[];
  /** FTS snippet (or an excerpt of the explanation in the LIKE-fallback path). */
  snippet: string;
  updated_at: string | null;
}

export interface AnnotationSearchResult {
  query: string;
  /** "fts" when the FTS5 index served it, "like" when it fell back. */
  mode: "fts" | "like" | string;
  hits: AnnotationSearchHit[];
}

export interface AnnotationExplanation {
  annotation_id: number;
  scope: string;
  ref_id: number;
  target: string;
  user_explanation: string;
  tags: string[];
  updated_at: string | null;
}

export interface AnnotationBacklinksResult {
  target: string;
  count: number;
  backlinks: Backlink[];
}
