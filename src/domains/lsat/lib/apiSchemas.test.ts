import { describe, expect, it } from "vitest";
import {
  activityEventSchema,
  ApiValidationError,
  artifactVersionSchema,
  backlinkSchema,
  citationTargetSchema,
  contentDuplicateRemediationResultSchema,
  contentHealthSchema,
  contentRevalidationRemediationResultSchema,
  contentSourceRegistrySchema,
  contentVersionSchema,
  contextPresetSchema,
  conceptCardsResultSchema,
  dashboardSchema,
  finishResultSchema,
  forecastSchema,
  knowledgeInboxItemSchema,
  notebookChatMessageSchema,
  notebookChatSessionSchema,
  notebookChatTurnResultSchema,
  notebookSearchSchema,
  podcastEpisodeSchema,
  questionResponseSchema,
  rcDashboardSchema,
  rcPassageMapSchema,
  regressionAlertsSchema,
  sectionDetailSchema,
  sessionResultsSchema,
  scheduledTaskRunResultSchema,
  scheduledTasksSchema,
  transformationRunSchema,
  tutorConversationSchema,
  tutorTurnResultSchema,
  validateResponse,
  validatorRunSchema,
  whyLoopSchema,
  workspaceManifestSchema,
} from "./apiSchemas";

const validQuestion = {
  id: 1,
  section_id: 10,
  passage_id: null,
  prompt: "Which one of the following…",
  stem: "A premise.",
  q_type: "Flaw",
  difficulty: 3,
  source: "official",
  choices: [
    { id: 1, label: "A", text: "first" },
    { id: 2, label: "B", text: "second" },
  ],
};

const validSection = {
  id: 10,
  preptest_id: 2,
  type: "LR",
  time_limit_sec: 2100,
  passages: [],
  questions: [validQuestion],
};

describe("apiSchemas — hot-path validation (5.1)", () => {
  it("parses a well-formed section detail and returns the data", () => {
    const out = validateResponse(sectionDetailSchema, validSection, "/api/sections/10");
    expect(out.id).toBe(10);
    expect(out.questions[0].choices).toHaveLength(2);
  });

  it("parses a well-formed question", () => {
    const out = validateResponse(questionResponseSchema, validQuestion, "/api/questions/1");
    expect(out.q_type).toBe("Flaw");
  });

  it("tolerates additive/unknown fields (forward-compatible passthrough)", () => {
    const withExtra = { ...validSection, future_field: 123, questions: [{ ...validQuestion, foo: "bar" }] };
    expect(() =>
      validateResponse(sectionDetailSchema, withExtra, "/api/sections/10"),
    ).not.toThrow();
  });

  it("throws a typed ApiValidationError on a malformed section (missing questions)", () => {
    const bad = { id: 10, preptest_id: 2, type: "LR", time_limit_sec: 2100, passages: [] };
    try {
      validateResponse(sectionDetailSchema, bad, "/api/sections/10");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect((err as ApiValidationError).path).toBe("/api/sections/10");
      expect((err as ApiValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("throws when a field has the wrong type (difficulty as string)", () => {
    const bad = { ...validQuestion, difficulty: "hard" };
    expect(() =>
      validateResponse(questionResponseSchema, bad, "/api/questions/1"),
    ).toThrow(ApiValidationError);
  });

  it("validates session results, finish result and forecast happy paths", () => {
    const results = {
      session: { id: 5, type: "section", started: "2026-05-01T00:00:00Z" },
      items: [
        {
          question: validQuestion,
          attempt: {
            attempt_id: 99,
            chosen_answer: "A",
            br_answer: null,
            is_correct: true,
            br_correct: null,
            time_ms: 4200,
            outcome: "timed_ok",
          },
        },
      ],
    };
    expect(() => validateResponse(sessionResultsSchema, results, "/r")).not.toThrow();
    expect(() =>
      validateResponse(finishResultSchema, { raw_correct: 20, total: 25 }, "/f"),
    ).not.toThrow();
    expect(() =>
      validateResponse(
        forecastSchema,
        {
          current_score: 160,
          projected_score: 165,
          slope_per_week: 1,
          confidence: { low: 160, high: 170 },
          target_score: 170,
          gap_to_target: 5,
          on_track: false,
          days_to_exam: 30,
          n_points: 5,
        },
        "/fc",
      ),
    ).not.toThrow();
  });

  it("accepts fresh-database dashboard metrics before score calibration exists", () => {
    const out = validateResponse(
      dashboardSchema,
      {
        predicted_score: null,
        score_delta_30d: null,
        trend: [],
        weakest_types: [],
        coach: {
          text: "Start with a timed baseline.",
          recommendation: { label: "Take a section", action: { type: "route" } },
        },
        streak_days: 0,
      },
      "/api/analytics/dashboard",
    );
    expect(out.predicted_score).toBeNull();
    expect(out.score_delta_30d).toBeNull();
  });

  it("accepts backend silent-regression alert payloads", () => {
    const out = validateResponse(
      regressionAlertsSchema,
      {
        model: "silent_regression_v1",
        source: "all",
        recent_days: 7,
        baseline_days: 30,
        min_attempts: 6,
        min_drop: 0.15,
        status: "regression",
        alerts: [
          {
            q_type: "Flaw",
            section_type: "LR",
            recent_attempts: 8,
            baseline_attempts: 12,
            recent_correct: 2,
            baseline_correct: 10,
            recent_accuracy: 0.25,
            baseline_accuracy: 0.8333,
            delta: -0.5833,
            z_score: -2.7,
            statistically_significant: true,
            severity: "high",
            reason: "recent_accuracy_drop",
          },
        ],
        summary: {
          alert_count: 1,
          checked_types: 1,
          insufficient_types: 0,
          recent_window_start: "2026-06-04T00:00:00Z",
          baseline_window_start: "2026-05-05T00:00:00Z",
        },
        insufficient: [],
      },
      "/api/analytics/regressions",
    );
    expect(out.alerts[0].severity).toBe("high");
  });

  it("rejects a malformed finish result (raw_correct missing)", () => {
    expect(() =>
      validateResponse(finishResultSchema, { total: 25 }, "/api/sessions/1/finish"),
    ).toThrow(ApiValidationError);
  });

  it("validates Notebook OS hot responses and preserves fallback metadata", () => {
    const source = {
      id: 1,
      workspace_id: 1,
      artifact_id: 2,
      title: "Source",
      source_type: "text",
      status: "ready",
      content_type: "text/plain",
      provider: "local",
      official_firewall: false,
      processing: {},
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    };
    const note = {
      id: 2,
      workspace_id: 1,
      artifact_id: 3,
      note_type: "manual",
      title: "Note",
      content: "content",
      citations: ["source:1"],
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    };
    const artifact = {
      id: 3,
      workspace_id: 1,
      kind: "note",
      title: "Artifact",
      body: "body",
      summary: "summary",
      source_kind: "manual",
      visibility: "local",
      official_firewall: false,
      cloud_allowed: true,
      export_eligible: true,
      tags: [],
      meta: {},
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    };
    const search = validateResponse(
      notebookSearchSchema,
      {
        query: "scope",
        artifacts: [artifact],
        notes: [note],
        sources: [source],
        artifact_search: { mode: "like_fallback", fallback_used: true },
      },
      "/api/notebook-search",
    );
    expect(search.artifact_search?.fallback_used).toBe(true);

    expect(() =>
      validateResponse(
        notebookChatTurnResultSchema,
        {
          user: {
            id: 1,
            session_id: 1,
            role: "user",
            content: "why",
            citations: [],
            meta: {},
            created_at: "2026-05-01T00:00:00Z",
          },
          assistant: {
            id: 2,
            session_id: 1,
            role: "assistant",
            content: "because",
            citations: [{ target: "source:1" }],
            meta: { generation: { mode: "template" } },
            created_at: "2026-05-01T00:00:00Z",
          },
          firewall_decision: {},
        },
        "/api/notebook-chat/sessions/1/messages",
      ),
    ).not.toThrow();
  });

  it("validates Trust OS scheduler contracts used by Content Ops", () => {
    const task = {
      id: 1,
      key: "daily_backup",
      label: "Daily backup",
      task_type: "backup",
      cadence_s: 86400,
      status: "idle",
      enabled: true,
      last_run_at: null,
      next_run_at: "2026-05-27T00:00:00Z",
      payload: {},
      updated_at: "2026-05-26T00:00:00Z",
    };
    const tasks = validateResponse(
      scheduledTasksSchema,
      { count: 1, tasks: [task] },
      "/api/observability/scheduled-tasks",
    );
    expect(tasks.tasks[0].key).toBe("daily_backup");

    const run = validateResponse(
      scheduledTaskRunResultSchema,
      {
        ok: true,
        run_id: 7,
        task,
        duration_ms: 12.5,
        result: { backup: "snapshot.db" },
        error: null,
      },
      "/api/observability/scheduled-tasks/daily_backup/run",
    );
    expect(run.ok).toBe(true);
    expect(run.task?.enabled).toBe(true);

    expect(() =>
      validateResponse(
        scheduledTasksSchema,
        { count: 1, tasks: [{ ...task, enabled: "yes" }] },
        "/api/observability/scheduled-tasks",
      ),
    ).toThrow(ApiValidationError);
  });

  it("validates Tutor OS why-loop, conversation, turn, and SRS contracts", () => {
    const why = validateResponse(
      whyLoopSchema,
      {
        attempt_id: 11,
        question_id: 22,
        q_type: "Flaw",
        mode: "socratic_blind_review",
        answer_key_hidden: true,
        next_step: "written_rationale",
        steps: [{ key: "prediction", complete: true, value: "A" }],
        rationales: [
          {
            id: 3,
            stage: "blind_review",
            answer: "B",
            confidence: "likely",
            trap_guess: "scope_shift",
            created_at: "2026-05-26T00:00:00Z",
          },
        ],
        local_evidence: { rationale_count: 1 },
      },
      "/api/attempts/11/why-loop",
    );
    expect(why.next_step).toBe("written_rationale");

    const turn = {
      id: 1,
      conversation_id: 4,
      role: "assistant",
      content: "Name the conclusion first.",
      meta: {
        local_only: true,
        socratic_context: {
          answer_key_hidden: true,
          prior_turn_count: 1,
          question_context: {
            question_id: 22,
            attempt_id: 11,
            q_type: "Inference",
            section_type: "RC",
            stem_excerpt: "The board's permit rule applies only to wetlands.",
            prompt_excerpt: "Which choice most strongly supports the reasoning?",
            selected_answer: "B",
            trap_guess: "scope_shift",
            passage_id: 5,
            passage_topic: "watershed permits",
            passage_excerpt:
              "The passage contrasts a narrow permit rule with watershed planning.",
          },
          similar_misses: [
            {
              question_id: 42,
              q_type: "Flaw",
              matched_by: "semantic",
              similarity: 0.93,
              trap_guess: "scope_shift",
              rationale_excerpt: "I overread the scope.",
            },
            {
              question_id: 43,
              q_type: "Inference",
              matched_by: "trap_type",
              trap_type: "scope_shift",
              chosen_answer: "B",
              note_excerpt: "I broadened the passage claim.",
              created_at: "2026-05-25T00:00:00Z",
              missed_at: "2026-05-25T00:00:00Z",
              source: "trap_similar",
            },
          ],
          notebook_context: {
            count: 1,
            notes: ["Scope note"],
            items: [
              {
                kind: "note",
                id: 7,
                title: "Scope shift notebook",
                excerpt: "Preserve actor and scope.",
              },
            ],
          },
        },
      },
      created_at: "2026-05-26T00:00:00Z",
    };
    const conversation = validateResponse(
      tutorConversationSchema,
      {
        id: 4,
        question_id: 22,
        attempt_id: 11,
        mode: "socratic",
        title: "Flaw why loop",
        turns: [turn],
        created_at: "2026-05-26T00:00:00Z",
        updated_at: "2026-05-26T00:00:00Z",
      },
      "/api/conversations/4",
    );
    expect(conversation.turns[0].role).toBe("assistant");
    expect(
      conversation.turns[0].meta.socratic_context?.similar_misses?.[0]
        ?.trap_guess,
    ).toBe("scope_shift");
    expect(
      conversation.turns[0].meta.socratic_context?.question_context
        ?.passage_topic,
    ).toBe("watershed permits");
    expect(
      conversation.turns[0].meta.socratic_context?.similar_misses?.[1]
        ?.trap_type,
    ).toBe("scope_shift");

    const result = validateResponse(
      tutorTurnResultSchema,
      { turn: { ...turn, role: "user" }, reply: turn },
      "/api/conversations/4/turns",
    );
    expect(result.reply?.content).toContain("conclusion");
    expect(result.reply?.meta.socratic_context?.notebook_context?.items?.[0]?.title).toBe(
      "Scope shift notebook",
    );

    expect(() =>
      validateResponse(
        tutorTurnResultSchema,
        { turn },
        "/api/conversations/4/turns",
      ),
    ).toThrow(ApiValidationError);

    expect(() =>
      validateResponse(
        conceptCardsResultSchema,
        { created: 1, skipped: 0, origin: "trap_recognition", card_id: 9, reason: "created_from_rationale" },
        "/api/attempts/11/concept-cards",
      ),
    ).not.toThrow();
  });

  it("validates central Notebook OS and trust cockpit contracts", () => {
    const timestamp = "2026-05-26T00:00:00Z";
    const workspace = validateResponse(
      workspaceManifestSchema,
      {
        id: 1,
        key: "default",
        title: "LSAT Notebook OS",
        description: "Local evidence graph.",
        home_artifact_id: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
      "/api/workspaces/default",
    );
    expect(workspace.key).toBe("default");

    const artifact = {
      id: 10,
      workspace_id: 1,
      kind: "note",
      title: "Flaw note",
      body: "body",
      summary: "summary",
      source_kind: "manual",
      visibility: "local",
      official_firewall: true,
      cloud_allowed: false,
      export_eligible: false,
      tags: ["flaw"],
      meta: {},
      evidence_refs: [
        {
          id: 1,
          artifact_id: 10,
          kind: "question",
          entity_id: "5",
          target: "question:5",
          official_firewall: true,
          created_at: timestamp,
        },
      ],
      citations: [
        {
          id: 1,
          artifact_id: 10,
          target: "question:5",
          target_kind: "question",
          label: "Question 5",
          snippet: "Official LSAT content is local-only.",
          official_firewall: true,
          created_at: timestamp,
        },
      ],
      created_at: timestamp,
      updated_at: timestamp,
    };
    expect(validateResponse(citationTargetSchema, artifact.citations[0], "/api/citations/question:5").target).toBe(
      "question:5",
    );
    expect(() => validateResponse(artifactVersionSchema, {
      id: 1,
      artifact_id: 10,
      version: 1,
      reason: "capture",
      snapshot: artifact,
      created_at: timestamp,
    }, "/api/evidence/artifacts/10/versions")).not.toThrow();
    expect(() => validateResponse(backlinkSchema, {
      id: 1,
      source_artifact_id: 10,
      source_title: "Flaw note",
      source_kind: "note",
      source_summary: "summary",
      source_official_firewall: true,
      target_ref: "question:5",
      relation: "cites",
      q_type: "Flaw",
      trap: null,
      role: null,
      meta: {},
      created_at: timestamp,
    }, "/api/backlinks/question:5")).not.toThrow();
    expect(() => validateResponse(knowledgeInboxItemSchema, {
      id: 1,
      artifact_id: 10,
      artifact_title: "Flaw note",
      origin: "capture",
      status: "open",
      priority: 0,
      reason: "Captured into Notebook OS",
      created_at: timestamp,
      resolved_at: null,
    }, "/api/knowledge-inbox")).not.toThrow();

    const chatSession = {
      id: 2,
      workspace_id: 1,
      title: "Notebook tutor",
      mode: "answer_key_locked",
      model: "local",
      context: { refs: ["question:5"] },
      created_at: timestamp,
      updated_at: timestamp,
    };
    const chatMessage = {
      id: 3,
      session_id: 2,
      role: "assistant",
      content: "Name the conclusion before choosing.",
      citations: [{ target: "question:5" }],
      meta: { retrieval: { reason: "answer_key_locked" } },
      created_at: timestamp,
    };
    expect(validateResponse(notebookChatSessionSchema, chatSession, "/api/notebook-chat/sessions").mode).toBe(
      "answer_key_locked",
    );
    expect(validateResponse(notebookChatMessageSchema, chatMessage, "/api/notebook-chat/messages").citations).toHaveLength(
      1,
    );

    const run = {
      id: 4,
      workspace_id: 1,
      template_key: "wrong_answer_packet",
      status: "done",
      prompt: "Build a packet.",
      input_refs: ["question:5"],
      output_artifact_id: 10,
      provider: "local",
      model: "deterministic",
      firewall_decision: { official_firewall: true, cloud_allowed: false },
      metrics: { evidence_count: 1 },
      created_at: timestamp,
      updated_at: timestamp,
    };
    expect(validateResponse(transformationRunSchema, run, "/api/transformations/4").template_key).toBe(
      "wrong_answer_packet",
    );

    const podcast = {
      id: 5,
      workspace_id: 1,
      title: "Weekly briefing",
      episode_type: "weekly_briefing",
      status: "transcript_ready",
      transcript: "A local-only briefing.",
      audio_path: null,
      source_refs: ["question:5"],
      provider: "local",
      firewall_decision: { official_firewall: true },
      duration_sec: 60,
      created_at: timestamp,
      updated_at: timestamp,
    };
    expect(validateResponse(podcastEpisodeSchema, podcast, "/api/podcasts").duration_sec).toBe(60);

    expect(() => validateResponse(activityEventSchema, {
      id: 6,
      kind: "transformation",
      status: "done",
      title: "Packet created",
      detail: {},
      entity: "transformation",
      entity_id: 4,
      progress_pct: 100,
      created_at: timestamp,
      updated_at: timestamp,
    }, "/api/activity")).not.toThrow();
    expect(() => validateResponse(contextPresetSchema, {
      id: 7,
      workspace_id: 1,
      name: "After reveal",
      modes: { default: "after_reveal" },
      policy: { official_firewall: true },
      created_at: timestamp,
      updated_at: timestamp,
    }, "/api/context-presets")).not.toThrow();

    const rcMap = {
      passage_id: 8,
      topic: "legal history",
      structure: {
        paragraph_count: 3,
        passage_type: "single",
        topic: "legal history",
        main_point_hint: "The author qualifies an old account.",
        question_mix: { "Main Point": 1 },
        line_reference_density: 0.25,
        viewpoint_count: 2,
        dominant_viewpoint: "qualified_or_opposing_view",
        evidence_anchor_count: 1,
        tag_coverage: {
          tagged_questions: 1,
          total_questions: 1,
          coverage: 1,
          low_confidence: 0,
          by_scope: { global: 1 },
        },
      },
      paragraph_roles: [
        {
          index: 1,
          line_ref: "P1",
          role: "setup",
          author_attitude: "neutral_descriptive",
          claim_density: 0.2,
          viewpoint: { label: "background_context", stance: "neutral", signals: [] },
          evidence_markers: ["evidence"],
          text_preview: "The passage opens by...",
        },
      ],
      evidence_refs: [
        {
          paragraph_index: 1,
          line_ref: "P1",
          marker: "evidence",
          evidence_type: "support",
          text_preview: "The passage opens by citing evidence.",
        },
      ],
      question_tags: [
        {
          question_id: 44,
          q_type: "MainPoint",
          scope: "global",
          anchor_ref: "whole_passage",
          requires_evidence: false,
          tags: ["global", "main_point"],
          tag_confidence: 1,
        },
      ],
      timing: { attempts: 0, avg_time_ms: null, accuracy: null, by_q_type: {} },
      generated_by: "local_heuristic_v1",
      updated_at: timestamp,
    };
    const parsedRcMap = validateResponse(rcPassageMapSchema, rcMap, "/api/rc/passages/8/map");
    expect(parsedRcMap.passage_id).toBe(8);
    expect(parsedRcMap.evidence_refs?.[0].line_ref).toBe("P1");
    expect(parsedRcMap.paragraph_roles[0].viewpoint?.label).toBe("background_context");
    expect(parsedRcMap.question_tags?.[0].anchor_ref).toBe("whole_passage");
    expect(parsedRcMap.question_tags?.[0].tag_confidence).toBe(1);
    expect(() => validateResponse(rcDashboardSchema, {
      passages: 1,
      questions: 4,
      mapped_passages: 1,
      coverage: 1,
      by_q_type: { "Main Point": 1 },
      tag_coverage: {
        tagged_questions: 4,
        total_questions: 4,
        coverage: 1,
        low_confidence: 0,
        by_scope: { global: 4 },
      },
      timing: rcMap.timing,
      next_actions: ["Keep RC maps fresh after each import and timed section."],
    }, "/api/rc/dashboard")).not.toThrow();

    expect(() => validateResponse(contentHealthSchema, {
      total_questions: 9,
      score: 94,
      status: "ok",
      warnings: [],
      by_source: { official: 8, research: 1 },
      by_q_type: { Flaw: 9 },
      tag_confidence: { low: 0, low_question_ids: [] },
      quarantine: { count: 0, question_ids: [] },
      duplicates: {
        clusters: [
          {
            content_hash: "hash-1",
            cluster_key: "text:abc123",
            duplicate_kind: "normalized_text",
            count: 2,
            question_ids: [1, 2],
            source_mix: { official: 1, research: 1 },
            q_type_mix: { Flaw: 2 },
            sample: "Duplicate sample",
          },
        ],
        cluster_count: 1,
      },
      official_firewall: { ok: true },
      validator_coverage: { known_validator_types: ["Flaw"] },
      choice_integrity: { nonstandard_choice_count: 0, question_ids: [] },
      versioning: { snapshots: 1, by_entity: { question: 1 } },
      provenance_score: {
        score: 97,
        status: "ok",
        summary: "2 active sources, 0 blocked, 0 warnings",
        blocked_source_keys: [],
        warning_source_keys: [],
        sources: [
          {
            key: "agieval-lsat-lr",
            label: "AGIEval LR",
            source_type: "research",
            license: "MIT",
            question_count: 1,
            score: 97,
            status: "ok",
            reasons: [],
            eligibility: { export: true },
            firewall: { cloud: true },
            seeded_from: "dataset_spec",
            quality: { low_tag_confidence: 0 },
          },
        ],
      },
    }, "/api/content/health")).not.toThrow();

    expect(() => validateResponse(contentSourceRegistrySchema, {
      id: 9,
      key: "lawhub",
      label: "LawHub",
      source_type: "official",
      license: "official",
      eligibility: { training: false },
      firewall: { cloud: "deny" },
      updated_at: timestamp,
      policy_review: {
        source_key: "lawhub",
        question_count: 12,
        requires_review: true,
        risks: [
          {
            code: "official_training_not_blocked",
            severity: "blocker",
            detail: "Official content must be blocked from training/export reuse.",
          },
        ],
        acknowledged_risks: ["official_training_not_blocked"],
        missing_acknowledgements: [],
        reviewed: true,
      },
      version: {
        id: 12,
        entity: "source_registry",
        entity_id: 9,
        version: 1,
        reason: "source_policy_review",
        snapshot: {},
        created_at: timestamp,
      },
    }, "/api/content/sources")).not.toThrow();
    expect(() => validateResponse(validatorRunSchema, {
      id: 10,
      q_type: "Flaw",
      section_type: "LR",
      status: "pass",
      score: 0.95,
      failure_reasons: [],
      meta: {},
      created_at: timestamp,
    }, "/api/content/validator-runs")).not.toThrow();
    expect(() => validateResponse(contentVersionSchema, {
      id: 11,
      entity: "question",
      entity_id: 5,
      version: 1,
      reason: "import",
      snapshot: {},
      created_at: timestamp,
    }, "/api/content/versions")).not.toThrow();
    expect(() => validateResponse(contentRevalidationRemediationResultSchema, {
      ok: true,
      action: "quarantine_failed",
      question_id: 45,
      validator_run_id: 9,
      version: {
        id: 12,
        entity: "question",
        entity_id: 45,
        version: 1,
        reason: "content_ops_failed_revalidation",
        snapshot: { approved: true },
        created_at: timestamp,
      },
      question: {
        id: 45,
        approved: false,
        quarantined: true,
        updated_at: timestamp,
      },
      remaining: {
        approved_ai_count: 2,
        due_count: 0,
        failed_count: 0,
        rc_count: 0,
        missing_evidence_count: 0,
        queue: [],
        recent_failures: [],
        lookback: 500,
        mode: "lightweight",
      },
    }, "/api/content/revalidation/45/remediate")).not.toThrow();
    expect(() => validateResponse(contentDuplicateRemediationResultSchema, {
      ok: true,
      action: "quarantine_duplicates",
      cluster_key: "text:abc123",
      duplicate_kind: "normalized_text",
      canonical_question_id: 17,
      quarantined_question_ids: [18, 19],
      versions: [
        {
          id: 13,
          entity: "question",
          entity_id: 17,
          version: 1,
          reason: "content_ops_duplicate_remediation",
          snapshot: { kept_as_canonical: true },
          created_at: timestamp,
        },
      ],
      remaining: {
        duplicates: {
          clusters: [],
          cluster_count: 0,
        },
      },
    }, "/api/content/duplicates/remediate")).not.toThrow();

    expect(() =>
      validateResponse(
        transformationRunSchema,
        { ...run, firewall_decision: "allowed" },
        "/api/transformations/4",
      ),
    ).toThrow(ApiValidationError);
  });
});
