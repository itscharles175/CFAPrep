import { useState } from "react";
import {
  Download,
  Keyboard,
  Palette,
  Sparkles,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/Primitives";
import { Icon } from "@lsat/components/ui/icon";
import { api } from "@lsat/lib/api";
import { PageSection } from "@lsat/components/page-layout";
import { getExamKiosk, setExamKiosk } from "@lsat/lib/prefs";
import { GoalSettingsForm } from "@lsat/components/settings/goal-settings-form";
import { KeyboardSettings } from "@lsat/components/settings/keyboard-settings";
import { TimerSettingsForm } from "@lsat/components/settings/timer-settings-form";
import { AccommodationsSettings } from "@lsat/components/settings/accommodations-settings";
import { DiagnosticsPanel } from "@lsat/components/settings/diagnostics-panel";
import { ModelRoutingCard } from "@lsat/components/settings/model-routing-card";
import { AppearanceSettings } from "@lsat/components/settings/appearance-settings";
import { cn } from "@lsat/lib/utils";
import "./utility-pages.css";

/** The in-page section map — drives both the anchor rail and the section order. */
const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "study", label: "Study", icon: Target },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "input", label: "Input", icon: Keyboard },
  { id: "ai-system", label: "AI & system", icon: Sparkles },
  { id: "data", label: "Data", icon: Download },
];

export default function Settings() {
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [kiosk, setKioskState] = useState(() => getExamKiosk());

  async function exportData() {
    setExporting(true);
    setExportMsg(null);
    try {
      // Use the unified, contract-backed export so the artifact carries the
      // backend's schema/checksum/provenance metadata. This also preserves the
      // official-content firewall instead of pretending analytics are a backup.
      const backup = await api.exportBackup({
        include_history: true,
        notes: "Created from StudyVault LSAT Settings",
      });
      const blob = new Blob(
        [JSON.stringify(backup, null, 2)],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `studyvault-lsat-backup-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg(`Backup created: ${a.download}`);
    } catch {
      setExportMsg("Backup could not be created. The LSAT service may be offline; your existing data is unchanged. Retry when it is available.");
    } finally {
      setExporting(false);
    }
  }

  return (
    // K4-10 — host chrome bridge. The page previously routed through the LSAT
    // `PageLayout` (eyebrow + serif title + graphite icon chip + a centered
    // `max-w-6xl` column from `width="2xl"`). On host primitives that maps to the
    // host `PageHeader` (eyebrow → badge, description → subtitle) inside the host
    // `.page-container`, with the wide two-column settings layout preserved via an
    // inner `mx-auto max-w-6xl` wrapper. The `Sliders` page-icon has no slot on
    // the host `PageHeader` and is dropped (parity with batch A/B). Forms and
    // section anchors keep their existing layout while data export uses the
    // unified contract-backed backup route below.
    <div className="page-container lsat-utility-page lsat-settings-page">
      <div className="mx-auto max-w-6xl space-y-[calc(var(--space-unit)*4)]">
        <PageHeader
          badge="Preferences"
          title="Settings"
          subtitle="Goals, appearance, input, AI, and your data — all on this device."
        />
        <div className="lsat-settings-grid grid gap-8 md:grid-cols-[12rem_minmax(0,1fr)]">
          <AnchorRail />

          <div className="min-w-0 space-y-10">
            <PageSection
              className="lsat-utility-section"
              eyebrow="STUDY"
              title="Goals & timing"
              description="Drive the dashboard countdown, on-track band, and section timers."
            >
              <div id="study" className="scroll-mt-24 space-y-4">
                <GoalSettingsForm />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Timer defaults</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TimerSettingsForm />
                  </CardContent>
                </Card>
                <AccommodationsSettings />
              </div>
            </PageSection>

            <PageSection
              className="lsat-utility-section"
              eyebrow="APPEARANCE"
              title="Theme & comfort"
              description="Tune how the app looks and how dense the data screens are."
            >
              <div id="appearance" className="scroll-mt-24">
                <Card>
                  <CardContent className="pt-[var(--card-pad)]">
                    <AppearanceSettings
                      kiosk={kiosk}
                      onKioskChange={(v) => {
                        setKioskState(v);
                        setExamKiosk(v);
                      }}
                    />
                  </CardContent>
                </Card>
              </div>
            </PageSection>

            <PageSection
              className="lsat-utility-section"
              eyebrow="INPUT"
              title="Keyboard"
              description="Customize exam keys and review the global shortcuts."
            >
              <div id="input" className="scroll-mt-24">
                <KeyboardSettings />
              </div>
            </PageSection>

            <PageSection
              className="lsat-utility-section"
              eyebrow="AI & SYSTEM"
              title="Model routing & diagnostics"
              description="Where realtime and batch AI run, plus local database health."
            >
              <div id="ai-system" className="scroll-mt-24 space-y-4">
                <ModelRoutingCard />
                <DiagnosticsPanel />
              </div>
            </PageSection>

            <PageSection
              className="lsat-utility-section"
              eyebrow="DATA"
              title="Backup & export"
              description="Everything stays on this machine."
            >
              <div id="data" className="scroll-mt-24">
                <Card>
                  <CardContent className="space-y-2 pt-[var(--card-pad)]">
                    <Button
                      variant="outline"
                      onClick={exportData}
                      disabled={exporting}
                    >
                      <Icon as={Download} size="sm" />
                      {exporting ? "Exporting…" : "Export / backup data"}
                    </Button>
                    {exportMsg && (
                      <p aria-live="polite" className="text-xs text-muted-foreground">{exportMsg}</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </PageSection>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Sticky in-page navigation for the settings sections (md+ only). */
function AnchorRail() {
  return (
    <nav
      aria-label="Settings sections"
      className="lsat-settings-rail hidden md:block"
    >
      <ul className="sticky top-4 space-y-0.5">
        {SECTIONS.map(({ id, label, icon }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors",
                "hover:bg-accent/50 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Icon as={icon} size="xs" />
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
