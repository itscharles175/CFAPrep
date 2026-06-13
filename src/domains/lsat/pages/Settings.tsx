import { useState } from "react";
import {
  Download,
  Keyboard,
  Palette,
  Sliders,
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
import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/api";
import { PageLayout, PageSection } from "@/components/page-layout";
import { getExamKiosk, setExamKiosk } from "@/lib/prefs";
import { GoalSettingsForm } from "@/components/settings/goal-settings-form";
import { KeyboardSettings } from "@/components/settings/keyboard-settings";
import { TimerSettingsForm } from "@/components/settings/timer-settings-form";
import { AccommodationsSettings } from "@/components/settings/accommodations-settings";
import { DiagnosticsPanel } from "@/components/settings/diagnostics-panel";
import { ModelRoutingCard } from "@/components/settings/model-routing-card";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { cn } from "@/lib/utils";

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
      // The export endpoint is not in the contract; we approximate by bundling
      // analytics + error log for a local download.
      const [dash, errors] = await Promise.all([
        api.dashboard().catch(() => null),
        api.errorLog().catch(() => []),
      ]);
      const blob = new Blob(
        [JSON.stringify({ dashboard: dash, error_log: errors }, null, 2)],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "lsatlab-export.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg("Exported to lsatlab-export.json");
    } catch {
      setExportMsg("Export failed (backend offline).");
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageLayout
      title="Settings"
      eyebrow="PREFERENCES"
      icon={Sliders}
      description="Goals, appearance, input, AI, and your data — all on this device."
      width="2xl"
    >
      <div className="grid gap-8 md:grid-cols-[12rem_minmax(0,1fr)]">
        <AnchorRail />

        <div className="min-w-0 space-y-10">
          <PageSection
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
            eyebrow="INPUT"
            title="Keyboard"
            description="Customize exam keys and review the global shortcuts."
          >
            <div id="input" className="scroll-mt-24">
              <KeyboardSettings />
            </div>
          </PageSection>

          <PageSection
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
                    <p className="text-xs text-muted-foreground">{exportMsg}</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </PageSection>
        </div>
      </div>
    </PageLayout>
  );
}

/** Sticky in-page navigation for the settings sections (md+ only). */
function AnchorRail() {
  return (
    <nav
      aria-label="Settings sections"
      className="hidden md:block"
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
