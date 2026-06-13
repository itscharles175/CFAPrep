import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChoiceList } from "@/components/question/choice-list";
import { cn } from "@/lib/utils";
import { setBrLastConfidence } from "@/lib/prefs";
import type { Choice, Confidence } from "@/lib/types";

const CONFIDENCE: { value: Confidence; label: string }[] = [
  { value: "sure", label: "Sure" },
  { value: "likely", label: "Pretty sure" },
  { value: "guess", label: "Guessing" },
];

export function BrAnswerPanel({
  choices,
  selected,
  confidence,
  onSelect,
  onConfidence,
  onReveal,
  canReveal,
}: {
  choices: Choice[];
  selected: string | null;
  confidence: Confidence;
  onSelect: (label: string) => void;
  onConfidence: (c: Confidence) => void;
  onReveal: () => void;
  canReveal: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="type-counsel text-lg font-normal">
          Take your time. Commit to your best answer now.
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <ChoiceList
          choices={choices.map((c) => ({
            id: c.id,
            label: c.label,
            text: c.text,
          }))}
          selected={selected}
          eliminated={new Set()}
          onSelect={onSelect}
          onToggleEliminate={() => {}}
        />
        <div>
          <div className="mb-2 text-sm font-medium">How confident are you?</div>
          <div className="grid grid-cols-3 gap-2">
            {CONFIDENCE.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  setBrLastConfidence(c.value);
                  onConfidence(c.value);
                }}
                aria-pressed={confidence === c.value}
                className={cn(
                  "rounded-card border px-4 py-3 text-sm font-medium transition-colors",
                  confidence === c.value
                    ? "border-primary bg-primary text-primary-foreground glow-verdict"
                    : "bg-surface-1 hover:bg-accent",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Keys: A–E commit · 1/2/3 confidence · R or Enter reveal · ←/→ navigate
          </p>
          <Button onClick={onReveal} disabled={!canReveal}>
            Reveal answer & explain
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
