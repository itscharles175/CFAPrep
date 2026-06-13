import { Eye, Lock, ShieldCheck, Sparkles, TextSearch, X } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/ui/icon";
import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  enabledCapabilities,
} from "@/lib/notebookCapabilities";
import type { ContextMode, NotebookContextModeCapability } from "@/lib/types";

const modeIcons: Record<string, typeof X> = {
  off: X,
  summary: Sparkles,
  full: TextSearch,
  answer_key_locked: Lock,
  after_reveal: Eye,
  official_firewalled: ShieldCheck,
};

export function ContextToggle({
  value,
  onChange,
  modes = DEFAULT_NOTEBOOK_CAPABILITIES.context_modes,
}: {
  value: ContextMode;
  onChange: (value: ContextMode) => void;
  modes?: NotebookContextModeCapability[];
}) {
  const visibleModes = enabledCapabilities(modes);
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next)}
      className="flex flex-wrap justify-start gap-1 rounded-md bg-surface-1 p-1"
      aria-label="Notebook context mode"
    >
      {visibleModes.map((mode) => {
        const ModeIcon = modeIcons[mode.icon ?? mode.value] ?? Sparkles;
        const hint = mode.description ?? mode.label;
        return (
          <Tooltip key={mode.value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={mode.value}
                aria-label={hint}
                className="h-9 gap-1.5 rounded px-2 text-xs"
              >
                <Icon as={ModeIcon} size="sm" />
                <span>{mode.label}</span>
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}
