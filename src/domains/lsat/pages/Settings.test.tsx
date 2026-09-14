import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";

const mocks = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  createObjectURL: vi.fn(() => "blob:studyvault-backup"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("@lsat/lib/api", () => ({ api: { exportBackup: mocks.exportBackup } }));
vi.mock("@lsat/lib/prefs", () => ({
  getExamKiosk: () => false,
  setExamKiosk: vi.fn(),
}));
vi.mock("@lsat/components/settings/goal-settings-form", () => ({ GoalSettingsForm: () => <div /> }));
vi.mock("@lsat/components/settings/keyboard-settings", () => ({ KeyboardSettings: () => <div /> }));
vi.mock("@lsat/components/settings/timer-settings-form", () => ({ TimerSettingsForm: () => <div /> }));
vi.mock("@lsat/components/settings/accommodations-settings", () => ({ AccommodationsSettings: () => <div /> }));
vi.mock("@lsat/components/settings/diagnostics-panel", () => ({ DiagnosticsPanel: () => <div /> }));
vi.mock("@lsat/components/settings/model-routing-card", () => ({ ModelRoutingCard: () => <div /> }));
vi.mock("@lsat/components/settings/appearance-settings", () => ({ AppearanceSettings: () => <div /> }));

describe("LSAT Settings backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportBackup.mockResolvedValue({
      format: "studyvault.unified-backup",
      schemaVersion: 1,
      checksum: "sha256:test",
      data: { lsat: { questions: [] } },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: mocks.createObjectURL,
      revokeObjectURL: mocks.revokeObjectURL,
    });
  });

  it("uses the contract-backed unified backup and names the artifact clearly", async () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: /Export \/ backup data/i }));

    await waitFor(() => expect(mocks.exportBackup).toHaveBeenCalledWith({
      include_history: true,
      notes: "Created from StudyVault LSAT Settings",
    }));
    expect(await screen.findByText(/Backup created: studyvault-lsat-backup-\d{4}-\d{2}-\d{2}\.json/)).toBeInTheDocument();
    expect(mocks.createObjectURL).toHaveBeenCalled();
  });

  it("surfaces failed backups without claiming that an export succeeded", async () => {
    mocks.exportBackup.mockRejectedValue(new Error("offline"));
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: /Export \/ backup data/i }));

    expect(await screen.findByText(/Backup could not be created.*existing data is unchanged/i)).toBeInTheDocument();
  });
});
