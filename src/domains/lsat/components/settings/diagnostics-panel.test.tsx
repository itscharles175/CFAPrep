import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@lsat/test/setup";
import { DiagnosticsPanel } from "./diagnostics-panel";

const mocks = vi.hoisted(() => ({
  useBackupIntegrity: vi.fn(),
  useBackups: vi.fn(),
  useContentHealth: vi.fn(),
  useObservability: vi.fn(),
  useReleaseTrust: vi.fn(),
  useRuntimeEvidence: vi.fn(),
  useScheduledTasks: vi.fn(),
  useCreateBackup: vi.fn(),
  useRestoreBackup: vi.fn(),
  runScheduledTask: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  getAppLogDir: vi.fn(),
  getBackendStatus: vi.fn(),
  restartBackend: vi.fn(),
  exportBackendLogs: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useBackupIntegrity: mocks.useBackupIntegrity,
  useBackups: mocks.useBackups,
  useContentHealth: mocks.useContentHealth,
  useObservability: mocks.useObservability,
  useReleaseTrust: mocks.useReleaseTrust,
  useRuntimeEvidence: mocks.useRuntimeEvidence,
  useScheduledTasks: mocks.useScheduledTasks,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useCreateBackup: mocks.useCreateBackup,
  useRestoreBackup: mocks.useRestoreBackup,
}));

vi.mock("@lsat/lib/api", () => ({
  api: {
    runScheduledTask: mocks.runScheduledTask,
  },
}));

vi.mock("@lsat/lib/toast", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
  },
}));

vi.mock("@lsat/lib/tauri", () => ({
  exportBackendLogs: mocks.exportBackendLogs,
  getAppLogDir: mocks.getAppLogDir,
  getBackendStatus: mocks.getBackendStatus,
  openPath: mocks.openPath,
  restartBackend: mocks.restartBackend,
}));

function query<T>(data: T) {
  return {
    data: { data, usingSample: false },
    refetch: vi.fn(),
    isError: false,
  };
}

function renderPanel() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DiagnosticsPanel />
    </QueryClientProvider>,
  );
}

describe("DiagnosticsPanel reliability console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppLogDir.mockResolvedValue(null);
    mocks.getBackendStatus.mockResolvedValue(null);
    mocks.restartBackend.mockResolvedValue(null);
    mocks.exportBackendLogs.mockResolvedValue(null);
    mocks.useBackupIntegrity.mockReturnValue(query({ result: "ok" }));
    mocks.useBackups.mockReturnValue(query({ backups: [] }));
    mocks.useContentHealth.mockReturnValue(
      query({ score: 100, status: "ok", warnings: [] }),
    );
    mocks.useObservability.mockReturnValue(
      query({
        worker_alive: true,
        gen_queued: 0,
        gen_running: 0,
        last_coach_refresh_ms: null,
        explain_p50_ms: 1200,
        embed_coverage_pct: 95,
      }),
    );
    mocks.useReleaseTrust.mockReturnValue(
      query({
        schema: "lsatlab.release_trust.v1",
        tier: "dev",
        status: "ok",
        score: 100,
        generated_at: new Date().toISOString(),
        app_version: "1.0.0",
        environment: {},
        checks: {
          release_local: {
            status: "ok",
            summary: "release:local gate evidence is current and complete",
            detail: {
              freshness_contract: {
                ready: true,
                report_head: "7c9914717709d8fb756e6b184244f0419efc9d58",
                live_head: "7c9914717709d8fb756e6b184244f0419efc9d58",
                branch: "codex/vnext-roadmap-foundation",
                reasons: [],
                blocking_status_lines: [],
                ignored_status_lines: ["?? AGENTS.md", "?? CLAUDE.md"],
              },
            },
            action: null,
          },
          model_readiness: {
            status: "ok",
            summary: "local model provider is reachable",
            detail: { provider: "ollama", provider_reachable: true },
            action: null,
          },
          runtime_evidence: {
            status: "ok",
            summary: "local runtime logs and metrics are observable",
            detail: { log_file_count: 1, recent_error_count: 0 },
            action: null,
          },
          backup_integrity: {
            status: "ok",
            summary: "local backup is fresh",
            detail: {},
            action: null,
          },
          scheduler: {
            status: "ok",
            summary: "scheduled maintenance registry is healthy",
            detail: {},
            action: null,
          },
          benchmarks: {
            status: "ok",
            summary: "recent benchmark and generation-quality evidence is present",
            detail: {
              generation_quality: {
                present: true,
                ok: true,
                run_id: 7,
              },
            },
            action: null,
          },
          backend_readiness: {
            status: "ok",
            summary: "database and migrations are ready",
            detail: {},
            action: null,
          },
          content_health: {
            status: "ok",
            summary: "content health is acceptable",
            detail: {},
            action: null,
          },
        },
        blockers: [],
        warnings: [],
        next_actions: [],
      }),
    );
    mocks.useRuntimeEvidence.mockReturnValue(
      query({
        ok: true,
        status: "ok",
        generated_at: new Date().toISOString(),
        log_dir: "C:\\Users\\charl\\LSATLab\\backend\\logs",
        log_dir_exists: true,
        log_dir_writable: true,
        log_file_count: 1,
        log_files: [],
        recent_error_count: 0,
        recent_errors: [],
        last_request_error: null,
        metrics: { available: true },
        crash_free_window: { status: "unknown" },
      }),
    );
    mocks.useScheduledTasks.mockReturnValue(
      query({
        count: 1,
        tasks: [
          {
            id: 1,
            key: "daily_backup",
            label: "Daily local database backup",
            task_type: "backup",
            cadence_s: 86400,
            status: "idle",
            enabled: true,
            last_run_at: new Date(Date.now() - 60_000).toISOString(),
            next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
            payload: {},
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    );
    mocks.useCreateBackup.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useRestoreBackup.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.runScheduledTask.mockResolvedValue({ ok: true, run_id: 2 });
  });

  it("surfaces release evidence and scheduler freshness in one panel", () => {
    renderPanel();

    expect(screen.getByText("Reliability console")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("ollama reachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rerun diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("Release evidence")).toBeInTheDocument();
    expect(screen.getByText("ship ready")).toBeInTheDocument();
    expect(screen.getByText(/codex\/vnext-roadmap-foundation · 7c99147/)).toBeInTheDocument();
    expect(screen.getByText("Runtime evidence")).toBeInTheDocument();
    expect(screen.getByText("local runtime logs and metrics are observable")).toBeInTheDocument();
    expect(screen.getByText("Blocking changes: 0")).toBeInTheDocument();
    expect(screen.getByText("Ignored policy files: 2")).toBeInTheDocument();
    expect(screen.getByText("Release gate")).toBeInTheDocument();
    expect(
      screen.getByText("release:local gate evidence is current and complete"),
    ).toBeInTheDocument();
    expect(screen.getByText("Model readiness")).toBeInTheDocument();
    expect(screen.getByText("Generation gate")).toBeInTheDocument();
    expect(
      screen.getByText("recent benchmark and generation-quality evidence is present"),
    ).toBeInTheDocument();
    expect(screen.getByText("Runtime logs")).toBeInTheDocument();
    expect(screen.getByText("0 errors")).toBeInTheDocument();
    expect(screen.getByText("Log dir present")).toBeInTheDocument();
    expect(screen.getByText("Scheduled maintenance")).toBeInTheDocument();
    expect(screen.getByText("Daily local database backup")).toBeInTheDocument();
  });

  it("runs a scheduled task and refreshes trust evidence", async () => {
    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Run Daily local database backup" }),
    );

    await waitFor(() =>
      expect(mocks.runScheduledTask).toHaveBeenCalledWith("daily_backup"),
    );
    expect(mocks.success).toHaveBeenCalledWith("daily backup ran");
  });

  it("surfaces runtime errors and opens exported logs", async () => {
    mocks.exportBackendLogs.mockResolvedValue("C:\\Users\\charl\\LSATLab\\backend\\logs");
    mocks.useRuntimeEvidence.mockReturnValue(
      query({
        ok: false,
        status: "warn",
        generated_at: new Date().toISOString(),
        log_dir: "C:\\Users\\charl\\LSATLab\\backend\\logs",
        log_dir_exists: true,
        log_dir_writable: true,
        log_file_count: 2,
        log_files: [],
        recent_error_count: 1,
        recent_errors: [
          {
            level: "ERROR",
            status: 500,
            path: "/api/explain/stream",
            file: "backend.log",
            message: "provider timeout",
          },
        ],
        last_request_error: {
          level: "ERROR",
          status: 500,
          path: "/api/explain/stream",
          file: "backend.log",
          message: "provider timeout",
        },
        metrics: { available: true },
        crash_free_window: { status: "unknown" },
      }),
    );

    renderPanel();

    expect(screen.getByText("1 errors")).toBeInTheDocument();
    expect(screen.getByText("Last request error")).toBeInTheDocument();
    expect(screen.getByText("Inspect recent backend errors.")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Open reliability logs" }),
    );

    await waitFor(() => {
      expect(mocks.exportBackendLogs).toHaveBeenCalled();
      expect(mocks.openPath).toHaveBeenCalledWith(
        "C:\\Users\\charl\\LSATLab\\backend\\logs",
      );
    });
  });
});
