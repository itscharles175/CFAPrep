import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@lsat/test/setup";
import ContentOps from "./ContentOps";

const mocks = vi.hoisted(() => ({
  useAuditLog: vi.fn(),
  useBenchmarkRuns: vi.fn(),
  useContentHealth: vi.fn(),
  useContentRevalidation: vi.fn(),
  useContentSources: vi.fn(),
  useContentVersions: vi.fn(),
  useMigrationPreview: vi.fn(),
  useReleaseTrust: vi.fn(),
  useScheduledTasks: vi.fn(),
  useValidatorRuns: vi.fn(),
  runBenchmarkSmoke: vi.fn(),
  runContentRevalidation: vi.fn(),
  remediateContentDuplicate: vi.fn(),
  remediateContentRevalidation: vi.fn(),
  runScheduledTask: vi.fn(),
  upsertContentSource: vi.fn(),
  restoreContentVersion: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    detail?: unknown;
    constructor(message: string, status: number, detail?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.detail = detail;
    }
  },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useAuditLog: mocks.useAuditLog,
  useBenchmarkRuns: mocks.useBenchmarkRuns,
  useContentHealth: mocks.useContentHealth,
  useContentRevalidation: mocks.useContentRevalidation,
  useContentSources: mocks.useContentSources,
  useContentVersions: mocks.useContentVersions,
  useMigrationPreview: mocks.useMigrationPreview,
  useReleaseTrust: mocks.useReleaseTrust,
  useScheduledTasks: mocks.useScheduledTasks,
  useValidatorRuns: mocks.useValidatorRuns,
}));

vi.mock("@lsat/lib/api", () => ({
  ApiError: mocks.ApiError,
  api: {
    runBenchmarkSmoke: mocks.runBenchmarkSmoke,
    runContentRevalidation: mocks.runContentRevalidation,
    remediateContentDuplicate: mocks.remediateContentDuplicate,
    remediateContentRevalidation: mocks.remediateContentRevalidation,
    runScheduledTask: mocks.runScheduledTask,
    upsertContentSource: mocks.upsertContentSource,
    restoreContentVersion: mocks.restoreContentVersion,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
  },
}));

function query<T>(data: T) {
  return {
    data: { data, usingSample: false },
    isError: false,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ContentOps />
    </QueryClientProvider>,
  );
}

describe("ContentOps cockpit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuditLog.mockReturnValue(
      query({
        count: 1,
        by_entity: { question: 1 },
        by_field: { q_type: 1 },
        edits: [
          {
            id: 1,
            entity: "question",
            entity_id: 17,
            field: "q_type",
            old_value: "Inference",
            new_value: "Flaw",
            created_at: new Date().toISOString(),
          },
        ],
      }),
    );
    mocks.useContentHealth.mockReturnValue(
      query({
        total_questions: 48,
        score: 82,
        status: "warning",
        warnings: ["duplicate_content_hash"],
        by_source: { official: 42, research: 6 },
        by_q_type: { Flaw: 12 },
        tag_confidence: { low: 3, low_question_ids: [7, 8, 9] },
        quarantine: { count: 1, question_ids: [99] },
        duplicates: {
          clusters: [
            {
              content_hash: "hash-1",
              cluster_key: "text:abc123",
              duplicate_kind: "normalized_text",
              count: 3,
              question_ids: [17, 18, 19],
              recommended_canonical_id: 17,
              quarantine_candidate_ids: [18, 19],
              source_mix: { official: 2, research: 1 },
              q_type_mix: { Flaw: 3 },
              sample: "Researchers sampled only one neighborhood before generalizing citywide.",
            },
            { content_hash: "hash-2", count: 2, question_ids: [20, 21] },
          ],
          cluster_count: 2,
        },
        official_firewall: {
          ok: true,
          training_eligible_official_count: 0,
          question_ids: [],
          notebook_violations: { artifact_ids: [] },
        },
        validator_coverage: {
          ai_without_validator_count: 1,
          ai_without_validator_question_ids: [11],
          known_validator_types: ["Flaw", "Detail"],
        },
        choice_integrity: { nonstandard_choice_count: 0, question_ids: [] },
        versioning: { snapshots: 2, by_entity: { question: 2 } },
        provenance_score: {
          score: 91,
          status: "warning",
          summary: "2 active sources, 0 blocked, 1 warnings",
          blocked_source_keys: [],
          warning_source_keys: ["research"],
          sources: [
            {
              key: "official",
              label: "Official",
              source_type: "official",
              license: "personal-study",
              question_count: 42,
              score: 100,
              status: "ok",
              reasons: [],
              eligibility: { export: false },
              firewall: { cloud: false, training: false },
              seeded_from: "builtin",
              quality: { low_tag_confidence: 0 },
            },
            {
              key: "research",
              label: "Research",
              source_type: "research",
              license: null,
              question_count: 6,
              score: 72,
              status: "warning",
              reasons: ["license_missing"],
              eligibility: { export: false },
              firewall: { cloud: false, training: false },
              seeded_from: "builtin",
              quality: { low_tag_confidence: 3 },
            },
          ],
        },
        source_registry: {
          count: 2,
          sources: [
            {
              key: "official",
              label: "Official",
              source_type: "licensed",
              license: "personal-study",
              eligibility: { export: false },
              firewall: { cloud: false, training: false },
            },
            {
              key: "research",
              label: "Research",
              source_type: "open",
              license: "permissive",
              eligibility: { export: true },
              firewall: { cloud: true, training: true },
            },
          ],
        },
        validator_runs: {
          recent_count: 1,
          failure_reasons: { length_tell: 3 },
          recent: [
            {
              id: 1,
              q_type: "Flaw",
              section_type: "LR",
              status: "failed",
              score: 0.4,
              failure_reasons: ["length_tell"],
              meta: {
                question_id: 101,
                parent_question_id: 9,
                verdict_reason: "rc_scope_mismatch",
                rc_generation_context: {
                  passage_type: "single",
                  paragraph_count: 3,
                  target_scope: "global",
                  target_tags: ["global", "main_point"],
                  tag_coverage: {
                    tagged_questions: 1,
                    total_questions: 1,
                    coverage: 1,
                    low_confidence: 0,
                    by_scope: { global: 1 },
                  },
                },
              },
              created_at: new Date().toISOString(),
            },
          ],
        },
        revalidation: {
          approved_ai_count: 3,
          due_count: 1,
          failed_count: 1,
          rc_count: 1,
          missing_evidence_count: 1,
          lookback: 500,
          mode: "lightweight",
          queue: [
            {
              question_id: 44,
              q_type: "Detail",
              section_type: "RC",
              source: "ai_generated",
              content_fingerprint: "abc",
              latest_run_id: null,
              latest_status: null,
              latest_created_at: null,
              needs_revalidation: true,
              reasons: ["missing_revalidation_run", "rc_missing_passage"],
              choice_count: 5,
              has_passage: true,
              updated_at: null,
            },
          ],
          recent_failures: [
            {
              question_id: 45,
              q_type: "Weaken",
              section_type: "LR",
              source: "ai_generated",
              content_fingerprint: "def",
              latest_run_id: 9,
              latest_status: "failed",
              latest_created_at: new Date().toISOString(),
              needs_revalidation: true,
              reasons: ["last_revalidation_failed"],
              choice_count: 5,
              has_passage: false,
              updated_at: null,
            },
          ],
        },
      }),
    );
    mocks.useContentRevalidation.mockReturnValue(
      query({
        approved_ai_count: 3,
        due_count: 1,
        failed_count: 1,
        rc_count: 1,
        missing_evidence_count: 1,
        lookback: 500,
        mode: "lightweight",
        queue: [
          {
            question_id: 44,
            q_type: "Detail",
            section_type: "RC",
            source: "ai_generated",
            content_fingerprint: "abc",
            latest_run_id: null,
            latest_status: null,
            latest_created_at: null,
            needs_revalidation: true,
            reasons: ["missing_revalidation_run", "rc_missing_passage"],
            choice_count: 5,
            has_passage: true,
            updated_at: null,
          },
        ],
        recent_failures: [
          {
            question_id: 45,
            q_type: "Weaken",
            section_type: "LR",
            source: "ai_generated",
            content_fingerprint: "def",
            latest_run_id: 9,
            latest_status: "failed",
            latest_created_at: new Date().toISOString(),
            needs_revalidation: true,
            reasons: ["last_revalidation_failed"],
            choice_count: 5,
            has_passage: false,
            updated_at: null,
          },
        ],
      }),
    );
    mocks.useContentSources.mockReturnValue(query([]));
    mocks.useValidatorRuns.mockReturnValue(query([]));
    mocks.useContentVersions.mockReturnValue(
      query([
        {
          id: 1,
          entity: "question",
          entity_id: 45,
          version: 1,
          reason: "content_ops_failed_revalidation",
          snapshot: {
            remediation_action: "quarantine_failed",
            validator_run_id: 9,
            validator_failure_reasons: ["last_revalidation_failed"],
            source: "ai_generated",
          },
          created_at: new Date().toISOString(),
        },
        {
          id: 2,
          entity: "question",
          entity_id: 17,
          version: 1,
          reason: "content_ops_duplicate_remediation",
          snapshot: {
            remediation_action: "quarantine_duplicates",
            duplicate_cluster_key: "text:abc123",
            duplicate_kind: "normalized_text",
            canonical_question_id: 17,
            quarantined_question_ids: [18, 19],
            kept_as_canonical: true,
            source: "official",
          },
          created_at: new Date().toISOString(),
        },
        {
          id: 3,
          entity: "source_registry",
          entity_id: 1,
          version: 2,
          reason: "content_ops_source_policy_review",
          snapshot: {
            previous: {
              key: "official",
              label: "Official",
              source_type: "official",
              license: "personal-study",
              eligibility: { export: false },
              firewall: { cloud: false, training: false, export: false },
            },
            current: {
              key: "official",
              label: "Official reviewed",
              source_type: "official",
              license: "personal-study",
              eligibility: { export: false },
              firewall: { cloud: true, training: false, export: false },
            },
            policy_review: {
              source_key: "official",
              question_count: 42,
              requires_review: true,
              risks: [
                {
                  code: "official_cloud_not_blocked",
                  severity: "blocker",
                  detail: "Official content must be blocked from cloud providers.",
                },
              ],
              acknowledged_risks: ["official_cloud_not_blocked"],
              missing_acknowledgements: [],
              reviewed: true,
              reviewer_note: "Approved for personal study audit.",
            },
            reviewer_note: "Approved for personal study audit.",
          },
          created_at: new Date().toISOString(),
        },
      ]),
    );
    mocks.useReleaseTrust.mockReturnValue(
      query({
        schema: "lsatlab.release_trust.v1",
        tier: "release",
        status: "ok",
        score: 100,
        generated_at: new Date().toISOString(),
        app_version: "0.1.0",
        environment: {},
        checks: {
          release_local: {
            status: "ok",
            summary: "release:local gate evidence is current and complete",
            detail: {},
            action: null,
          },
          content_health: {
            status: "ok",
            summary: "content firewall and validator health are acceptable",
            detail: {},
            action: null,
          },
        },
        blockers: [],
        warnings: [],
        next_actions: [],
      }),
    );
    mocks.useScheduledTasks.mockReturnValue(
      query({
        count: 1,
        tasks: [
          {
            id: 1,
            key: "content_health",
            label: "Content health refresh",
            task_type: "audit",
            cadence_s: 86400,
            status: "idle",
            enabled: true,
            last_run_at: null,
            next_run_at: null,
            payload: {},
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    );
    mocks.useBenchmarkRuns.mockReturnValue(
      query({
        runs: [
          {
            id: 1,
            kind: "smoke",
            status: "ok",
            metrics: { explain_ms: 1200 },
            environment: {},
            created_at: new Date().toISOString(),
          },
        ],
      }),
    );
    mocks.useMigrationPreview.mockReturnValue(
      query({
        latest_expected_version: 16,
        pragma_user_version: 16,
        applied_count: 16,
        pending_count: 0,
        applied: [],
        pending: [],
        failed: [],
        checksum_mismatches: [],
        pre_migration_backup_required: true,
        restore_after_upgrade_smoke_required: true,
      }),
    );
    mocks.runBenchmarkSmoke.mockResolvedValue({ ok: true });
    mocks.runContentRevalidation.mockResolvedValue({
      ok: true,
      validated: 1,
      passed: 1,
      failed: 0,
      quarantined: 0,
      quarantined_question_ids: [],
      model_gate: false,
      apply_quarantine: false,
      force: false,
      runs: [],
      remaining: {
        approved_ai_count: 3,
        due_count: 0,
        failed_count: 0,
        rc_count: 1,
        missing_evidence_count: 0,
        lookback: 500,
        mode: "lightweight",
        queue: [],
        recent_failures: [],
      },
    });
    mocks.remediateContentRevalidation.mockResolvedValue({
      ok: true,
      action: "quarantine_failed",
      question_id: 45,
      validator_run_id: 9,
      version: {
        id: 3,
        entity: "question",
        entity_id: 45,
        version: 1,
        reason: "content_ops_failed_revalidation",
        snapshot: {},
        created_at: new Date().toISOString(),
      },
      question: {
        id: 45,
        approved: false,
        quarantined: true,
        updated_at: new Date().toISOString(),
      },
      remaining: {
        approved_ai_count: 2,
        due_count: 1,
        failed_count: 0,
        rc_count: 1,
        missing_evidence_count: 1,
        lookback: 500,
        mode: "lightweight",
        queue: [],
        recent_failures: [],
      },
    });
    mocks.remediateContentDuplicate.mockResolvedValue({
      ok: true,
      action: "quarantine_duplicates",
      cluster_key: "text:abc123",
      duplicate_kind: "normalized_text",
      canonical_question_id: 17,
      quarantined_question_ids: [18, 19],
      versions: [
        {
          id: 4,
          entity: "question",
          entity_id: 17,
          version: 1,
          reason: "content_ops_duplicate_remediation",
          snapshot: {},
          created_at: new Date().toISOString(),
        },
      ],
      remaining: {},
    });
    mocks.runScheduledTask.mockResolvedValue({ ok: true });
    mocks.upsertContentSource.mockResolvedValue({
      id: 1,
      key: "official",
      label: "Official",
      source_type: "official",
      license: "personal-study",
      eligibility: { export: false },
      firewall: { cloud: false, training: false },
      updated_at: new Date().toISOString(),
      policy_review: {
        source_key: "official",
        question_count: 42,
        requires_review: false,
        risks: [],
        acknowledged_risks: [],
        missing_acknowledgements: [],
        reviewed: false,
        reviewer_note: "",
      },
      version: {
        id: 6,
        entity: "source_registry",
        entity_id: 1,
        version: 1,
        reason: "source_policy_review",
        snapshot: {},
        created_at: new Date().toISOString(),
      },
    });
    mocks.restoreContentVersion.mockResolvedValue({
      id: 1,
      key: "official",
      label: "Official",
      source_type: "official",
      license: "personal-study",
      eligibility: { export: false },
      firewall: { cloud: false, training: false },
      updated_at: new Date().toISOString(),
      policy_review: {
        source_key: "official",
        question_count: 42,
        requires_review: false,
        risks: [],
        acknowledged_risks: [],
        missing_acknowledgements: [],
        reviewed: false,
        reviewer_note: "Rolled back official source policy from v2.",
      },
      version: {
        id: 8,
        entity: "source_registry",
        entity_id: 1,
        version: 3,
        reason: "content_ops_source_policy_restore",
        snapshot: {},
        created_at: new Date().toISOString(),
      },
    });
  });

  it("surfaces source trust, duplicate, validator, and version evidence", () => {
    renderPage();

    expect(screen.getByText("Trust cockpit")).toBeInTheDocument();
    expect(screen.getByText("Provenance score")).toBeInTheDocument();
    expect(screen.getByText("91/100")).toBeInTheDocument();
    expect(screen.getByText("Release contract")).toBeInTheDocument();
    expect(screen.getByText("release:local gate evidence is current and complete")).toBeInTheDocument();
    expect(screen.getByText("Approved AI revalidation")).toBeInTheDocument();
    expect(screen.getByText("Revalidation queue")).toBeInTheDocument();
    expect(screen.getByText("Question #44")).toBeInTheDocument();
    expect(screen.getByText("missing revalidation run")).toBeInTheDocument();
    expect(screen.getByText("rc missing passage")).toBeInTheDocument();
    expect(screen.getByText("passage-aware")).toBeInTheDocument();
    expect(screen.getByText("1 approved AI item has a failed latest revalidation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quarantine failed item #45/i })).toBeInTheDocument();
    expect(screen.getByText("Provenance scoring")).toBeInTheDocument();
    expect(screen.getByText("license missing")).toBeInTheDocument();
    expect(screen.getByText("Official firewall")).toBeInTheDocument();
    expect(screen.getAllByText("Duplicate clusters").length).toBeGreaterThan(0);
    expect(screen.getByText("Source trust summary")).toBeInTheDocument();
    expect(screen.getAllByText("Official").length).toBeGreaterThan(0);
    expect(screen.getAllByText("42 questions").length).toBeGreaterThan(0);
    // "text:abc123" now appears in BOTH the legacy findings card and the new
    // NearDuplicatePanel (Content integrity matrix), so assert >= 1.
    expect(screen.getAllByText("text:abc123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("normalized text").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Questions #17, #18, #19").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Keep question #17 and quarantine duplicates in text:abc123/i })).toBeInTheDocument();
    expect(screen.getByText("sources: official 2, research 1")).toBeInTheDocument();
    expect(screen.getByText("types: Flaw 3")).toBeInTheDocument();
    expect(screen.getAllByText("Researchers sampled only one neighborhood before generalizing citywide.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("length_tell").length).toBeGreaterThan(0);
    expect(screen.getByText("RC generation map")).toBeInTheDocument();
    expect(screen.getByText("single · 3 paragraphs · scope global")).toBeInTheDocument();
    expect(screen.getByText("Tags: global, main point")).toBeInTheDocument();
    expect(screen.getByText("1/1 tagged")).toBeInTheDocument();
    expect(screen.getByText("q#101")).toBeInTheDocument();
    expect(screen.getByText("parent #9")).toBeInTheDocument();
    expect(screen.getByText("rc scope mismatch")).toBeInTheDocument();
    expect(screen.getByText("question: 2")).toBeInTheDocument();
    expect(screen.getByText("Version history")).toBeInTheDocument();
    expect(screen.getByText("quarantine failed")).toBeInTheDocument();
    expect(screen.getByText("validator #9")).toBeInTheDocument();
    expect(screen.getByText("quarantine duplicates")).toBeInTheDocument();
    expect(screen.getByText("canonical #17")).toBeInTheDocument();
    expect(screen.getByText("quarantined #18, #19")).toBeInTheDocument();
    expect(screen.getByText("Source policy diff")).toBeInTheDocument();
    expect(screen.getByText(/blocked to/i)).toBeInTheDocument();
    expect(screen.getByText("Approved for personal study audit.")).toBeInTheDocument();
    expect(screen.getAllByText("official cloud not blocked").length).toBeGreaterThan(0);
  });

  it("surfaces release blockers as product-contract trust evidence", () => {
    mocks.useReleaseTrust.mockReturnValue(
      query({
        schema: "lsatlab.release_trust.v1",
        tier: "release",
        status: "blocked",
        score: 68,
        generated_at: new Date().toISOString(),
        app_version: "0.1.0",
        environment: {},
        checks: {
          release_local: {
            status: "block",
            summary: "release:local gate evidence is missing, stale, partial, or failed",
            detail: {
              freshness_contract: {
                ready: false,
                reasons: ["working_tree_has_blocking_changes"],
              },
            },
            action: "Run the full local release gate without skips before calling the build production-ready.",
          },
        },
        blockers: [
          {
            check: "release_local",
            summary: "release:local gate evidence is missing, stale, partial, or failed",
            action: "Run the full local release gate without skips before calling the build production-ready.",
          },
        ],
        warnings: [],
        next_actions: [
          "Run the full local release gate without skips before calling the build production-ready.",
        ],
      }),
    );

    renderPage();

    expect(screen.getByText("Release contract")).toBeInTheDocument();
    expect(screen.getByText("68/100")).toBeInTheDocument();
    expect(
      screen.getByText("release:local gate evidence is missing, stale, partial, or failed"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("blocker").length).toBeGreaterThan(0);
  });

  it("requests filtered version history from the cockpit controls", async () => {
    renderPage();

    expect(mocks.useContentVersions).toHaveBeenLastCalledWith({ limit: 200 });

    await userEvent.click(
      within(screen.getByRole("group", { name: /Version entity filters/i })).getByRole(
        "button",
        { name: /Sources/i },
      ),
    );
    await userEvent.click(
      within(screen.getByRole("group", { name: /Version reason filters/i })).getByRole(
        "button",
        { name: /Source policy/i },
      ),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /Filter version history by source key/i }),
      "official",
    );

    await waitFor(() =>
      expect(mocks.useContentVersions).toHaveBeenLastCalledWith({
        limit: 200,
        entity: "source_registry",
        reason_contains: "source_policy",
        source_key: "official",
      }),
    );
  });

  it("records a benchmark smoke run from the cockpit action", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Benchmark smoke/i }));

    await waitFor(() => expect(mocks.runBenchmarkSmoke).toHaveBeenCalled());
    expect(mocks.success).toHaveBeenCalledWith("Benchmark smoke recorded");
  });

  it("runs approved AI revalidation from the cockpit action", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Run due queue/i }));

    await waitFor(() =>
      expect(mocks.runContentRevalidation).toHaveBeenCalledWith({
        limit: 25,
        force: false,
      }),
    );
    expect(mocks.success).toHaveBeenCalledWith("1 content item revalidated");
  });

  it("quarantines a failed revalidation row from the cockpit", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Quarantine failed item #45/i }));

    await waitFor(() =>
      expect(mocks.remediateContentRevalidation).toHaveBeenCalledWith(45, {
        action: "quarantine_failed",
        reason: "content_ops_failed_revalidation",
      }),
    );
    expect(mocks.success).toHaveBeenCalledWith("Question #45 quarantined");
  });

  it("remediates a duplicate cluster from the cockpit", async () => {
    renderPage();

    await userEvent.click(
      screen.getByRole("button", {
        name: /Keep question #17 and quarantine duplicates in text:abc123/i,
      }),
    );

    await waitFor(() =>
      expect(mocks.remediateContentDuplicate).toHaveBeenCalledWith({
        action: "quarantine_duplicates",
        cluster_key: "text:abc123",
        canonical_question_id: 17,
        expected_question_ids: [17, 18, 19],
        reason: "content_ops_duplicate_remediation",
      }),
    );
    expect(mocks.success).toHaveBeenCalledWith("Kept #17; quarantined 2 duplicates");
  });

  it("rolls back a source policy version from history", async () => {
    renderPage();

    await userEvent.click(
      screen.getByRole("button", {
        name: /Roll back source policy official to previous version 2/i,
      }),
    );

    await waitFor(() =>
      expect(mocks.restoreContentVersion).toHaveBeenCalledWith(
        3,
        expect.objectContaining({
          target: "previous",
          reviewed: false,
          acknowledged_risks: [],
          reviewer_note: "Rolled back official source policy from v2.",
          reason: "content_ops_source_policy_restore",
        }),
      ),
    );
    expect(mocks.success).toHaveBeenCalledWith("Source policy rolled back");
  });

  it("restores a reviewed source policy snapshot with visible risk acknowledgements", async () => {
    renderPage();

    await userEvent.click(
      screen.getByRole("button", {
        name: /Restore source policy official version 2/i,
      }),
    );

    await waitFor(() =>
      expect(mocks.restoreContentVersion).toHaveBeenCalledWith(
        3,
        expect.objectContaining({
          target: "current",
          reviewed: true,
          acknowledged_risks: ["official_cloud_not_blocked"],
          reviewer_note: "Restored official source policy snapshot v2.",
          reason: "content_ops_source_policy_restore",
        }),
      ),
    );
    expect(mocks.success).toHaveBeenCalledWith("Source policy restored");
  });

  it("reviews and applies a risky source policy edit", async () => {
    const review = {
      source_key: "official",
      question_count: 42,
      requires_review: true,
      risks: [
        {
          code: "official_cloud_not_blocked",
          severity: "blocker",
          detail: "Official content must be blocked from cloud providers.",
        },
      ],
      acknowledged_risks: [],
      missing_acknowledgements: ["official_cloud_not_blocked"],
      reviewed: false,
      reviewer_note: "",
    };
    mocks.upsertContentSource
      .mockRejectedValueOnce(
        new mocks.ApiError("source_policy_review_required", 409, { review }),
      )
      .mockResolvedValueOnce({
        id: 1,
        key: "official",
        label: "Official",
        source_type: "official",
        license: "personal-study",
        eligibility: { export: false },
        firewall: { cloud: true, training: false },
        updated_at: new Date().toISOString(),
        policy_review: {
          ...review,
          acknowledged_risks: ["official_cloud_not_blocked"],
          missing_acknowledgements: [],
          reviewed: true,
          reviewer_note: "Temporary local audit approval",
        },
        version: {
          id: 7,
          entity: "source_registry",
          entity_id: 1,
          version: 2,
          reason: "content_ops_source_policy_review",
          snapshot: {},
          created_at: new Date().toISOString(),
        },
      });
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: /Edit source policy for Official/i }),
    );
    await userEvent.click(screen.getByRole("switch", { name: /Cloud policy/i }));
    await userEvent.type(
      screen.getByLabelText(/Reviewer note/i),
      "Temporary local audit approval",
    );
    await userEvent.click(screen.getByRole("button", { name: /Review policy/i }));

    expect((await screen.findAllByText("official cloud not blocked")).length).toBeGreaterThan(0);
    expect(mocks.error).toHaveBeenCalledWith("Review source policy risks before saving");
    expect(mocks.upsertContentSource).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: "official",
        reviewed: false,
        reviewer_note: "Temporary local audit approval",
        firewall: expect.objectContaining({ cloud: true, training: false }),
      }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Apply reviewed policy/i }),
    );

    await waitFor(() =>
      expect(mocks.upsertContentSource).toHaveBeenLastCalledWith(
        expect.objectContaining({
          key: "official",
          reviewed: true,
          acknowledged_risks: ["official_cloud_not_blocked"],
          reviewer_note: "Temporary local audit approval",
          reason: "content_ops_source_policy_review",
        }),
      ),
    );
    expect(mocks.success).toHaveBeenCalledWith("Reviewed source policy saved");
  });
});
