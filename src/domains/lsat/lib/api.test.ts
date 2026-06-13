import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { ApiValidationError } from "./apiSchemas";

// 7.2 — exercise the `request<T>` boundary in api.ts through the public client
// methods (the fn itself is module-private). We stub global.fetch so nothing
// hits the network and assert: ApiError status/detail mapping (string + object
// detail), the zod `validate` path (success passthrough, additive-field
// tolerance, ApiValidationError on drift), and the 204 no-content path.

/** A minimal fetch Response double for a JSON body. */
function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
): Response {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: init?.statusText ?? "",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A 204 (or otherwise body-less) response whose .json() would throw. */
function noContentResponse(status = 204): Response {
  return {
    ok: true,
    status,
    statusText: "",
    json: () => Promise.reject(new Error("no body")),
  } as unknown as Response;
}

const validSection = {
  id: 10,
  preptest_id: 2,
  type: "LR",
  time_limit_sec: 2100,
  passages: [],
  questions: [
    {
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
    },
  ],
};

describe("api.request — error mapping + validation boundary (7.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a successful JSON body straight through (no validate)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    await expect(api.health()).resolves.toEqual({ ok: true });
  });

  it("maps a string `detail` error body to ApiError.message + status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: "Section not found" }, { ok: false, status: 404 }),
      ),
    );
    await expect(api.health()).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Section not found",
    });
  });

  it("preserves a structured `detail` object on ApiError.detail (D1 gate)", async () => {
    const detail = { error: "Integrity check failed", issues: ["dup answer key"] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail }, { ok: false, status: 409 })),
    );
    let caught: unknown;
    try {
      await api.health();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(409);
    // Readable message taken from detail.error; full object preserved.
    expect(err.message).toBe("Integrity check failed");
    expect(err.detail).toEqual(detail);
  });

  it("treats a non-JSON response as unreachable so withFallback goes offline", async () => {
    // A reachable backend always answers /api with JSON; a non-JSON body means
    // we didn't reach the API (a dev proxy gateway error / SPA fallback when the
    // backend is down). request() surfaces that as a TypeError, which withFallback
    // maps to "offline → sample data" — NOT a real ApiError that would mask
    // "backend down" as a backend error (and break the no-backend render).
    const res = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    await expect(api.health()).rejects.toBeInstanceOf(TypeError);
  });

  it("returns undefined for a 204 no-content response", async () => {
    // saveAnnotations -> PUT returns 204; request<T> yields undefined and the
    // method resolves true. Use any 204-returning path: blindReview PATCH.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(noContentResponse(204)));
    await expect(
      api.blindReview(1, { br_answer: "A", confidence: "sure" }),
    ).resolves.toBeUndefined();
  });

  it("validates the hot path and returns parsed data on a well-formed body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(validSection)));
    const out = await api.section(10);
    expect(out.id).toBe(10);
    expect(out.questions[0].choices).toHaveLength(2);
  });

  it("tolerates additive/unknown fields on a validated response", async () => {
    const withExtra = {
      ...validSection,
      future_field: 123,
      questions: [{ ...validSection.questions[0], foo: "bar" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(withExtra)));
    await expect(api.section(10)).resolves.toMatchObject({ id: 10 });
  });

  it("throws ApiValidationError when a validated response drifts", async () => {
    const bad = { id: 10, preptest_id: 2, type: "LR", time_limit_sec: 2100, passages: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(bad)));
    let caught: unknown;
    try {
      await api.section(10);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiValidationError);
    expect((caught as ApiValidationError).path).toContain("/api/sections/10");
    expect((caught as ApiValidationError).issues.length).toBeGreaterThan(0);
  });

  it("serializes a JSON body and sets the Content-Type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ attempt_id: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.createAttempt(5, {
      question_id: 1,
      mode: "timed",
      chosen_answer: "A",
      time_ms: 1000,
      flagged: false,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({ question_id: 1 });
  });

  it("does not fake success when persistent bank bulk tagging fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: "database locked" }, { ok: false, status: 503 }),
      ),
    );

    await expect(
      api.bankBulkTag({ question_ids: [1], q_type: "Flaw" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "database locked",
    });
  });

  it("requests Notebook OS capabilities from the advertised capabilities endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        source_types: [],
        note_types: [],
        transform_templates: [],
        export_formats: [],
        context_modes: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.notebookCapabilities();

    expect(fetchMock.mock.calls[0][0]).toContain("/api/notebook-capabilities");
  });

  it("posts Notebook OS bundle imports to the portable import endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schema: "lsatlab.notebook_import.v1",
        title: "Imported",
        format: "markdown",
        created: { sources: 1, notes: 0, artifacts: 0 },
        created_refs: ["artifact:1"],
        skipped: [],
        firewall_decision: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.importNotebookBundle({
      title: "Imported",
      format: "markdown",
      content: "# Imported",
      official_firewall: true,
    });

    expect(fetchMock.mock.calls[0][0]).toContain("/api/notebook-import");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      title: "Imported",
      format: "markdown",
      official_firewall: true,
    });
  });

  it("patches Knowledge Inbox triage state through the Notebook OS contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 3,
        artifact_id: 10,
        artifact_title: "Captured idea",
        origin: "capture",
        status: "resolved",
        priority: 4,
        reason: "handled",
        created_at: "2026-05-26T00:00:00Z",
        resolved_at: "2026-05-26T00:01:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateKnowledgeInboxItem(3, { status: "resolved", priority: 4 });

    expect(fetchMock.mock.calls[0][0]).toContain("/api/knowledge-inbox/3");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
  });

  it("passes the readiness evidence window through the API query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        section_type: "RC",
        readiness_score: 50,
        status: "building",
        on_track: null,
        predicted_scaled_score: null,
        components: {
          mastery: 0.5,
          accuracy: null,
          blind_review_control: 0.5,
          evidence: 0.1,
          srs_load: 1,
          attempts_90d: 12,
          due_srs: 0,
        },
        ability: {
          q_type: null,
          section_type: "RC",
          ability: 0,
          mastery: 0.5,
          uncertainty: 1,
          evidence_n: 12,
          accuracy: null,
          avg_time_ms: null,
          components: {},
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.readiness("RC", false, 30);

    expect(fetchMock.mock.calls[0][0]).toContain("/api/readiness?");
    expect(fetchMock.mock.calls[0][0]).toContain("section_type=RC");
    expect(fetchMock.mock.calls[0][0]).toContain("persist=false");
    expect(fetchMock.mock.calls[0][0]).toContain("days=30");
  });

  it("passes the feedback cohort evidence window through the API query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "daily_plan_feedback_cohorts_v1",
        window_days: 90,
        generated_at: "2026-06-13T00:00:00Z",
        total_events_seen: 0,
        total: 0,
        complete: 0,
        skip: 0,
        reopen: 0,
        completion_rate: null,
        skip_rate: null,
        reopen_rate: null,
        minutes_completed: 0,
        avg_utility_score: null,
        selector_adjustment: 0,
        status: "no_feedback",
        latest_at: null,
        by_q_type: {},
        by_task_type: {},
        q_type_cohorts: [],
        task_type_cohorts: [],
        top_q_type: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.feedbackCohorts(90);

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/analytics/feedback-cohorts?days=90",
    );
  });

  it("passes feedback outcome filters through the API query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "daily_plan_feedback_outcomes_v1",
        feedback_window_days: 90,
        outcome_window_days: 30,
        source: "official",
        min_attempts: 4,
        generated_at: "2026-06-13T00:00:00Z",
        total_feedback_events_seen: 0,
        qualifying_feedback_events: 0,
        cohorts: [],
        by_q_type: {},
        summary: {
          status: "no_feedback",
          cohort_count: 0,
          planner_ready_cohorts: 0,
          best_lift_q_type: null,
          best_lift_action: null,
          best_lift_delta: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.feedbackOutcomes(90, 30, "official", 4);

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/analytics/feedback-outcomes?",
    );
    expect(fetchMock.mock.calls[0][0]).toContain("feedback_days=90");
    expect(fetchMock.mock.calls[0][0]).toContain("outcome_days=30");
    expect(fetchMock.mock.calls[0][0]).toContain("source=official");
    expect(fetchMock.mock.calls[0][0]).toContain("min_attempts=4");
  });

  it("validates scheduled task run responses before Content Ops trusts them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        run_id: 4,
        task: {
          id: 1,
          key: "daily_backup",
          label: "Daily backup",
          task_type: "backup",
          cadence_s: 86400,
          status: "idle",
          enabled: true,
          last_run_at: "2026-05-26T00:00:00Z",
          next_run_at: "2026-05-27T00:00:00Z",
          payload: {},
          updated_at: "2026-05-26T00:00:00Z",
        },
        duration_ms: 10,
        result: {},
        error: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.runScheduledTask("daily_backup")).resolves.toMatchObject({
      ok: true,
      task: { key: "daily_backup" },
    });
  });

  it("validates Tutor OS turn responses instead of pretending they are conversations", async () => {
    const turn = {
      id: 1,
      conversation_id: 7,
      role: "user",
      content: "I am stuck.",
      meta: { local_only: true },
      created_at: "2026-05-26T00:00:00Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ turn, reply: null })));

    await expect(api.addTutorTurn(7, { content: "I am stuck." })).resolves.toEqual({
      turn,
      reply: null,
    });
  });

  it("throws ApiValidationError when a Tutor OS turn response drifts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ turns: [] })));

    await expect(
      api.addTutorTurn(7, { content: "I am stuck." }),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });
});
