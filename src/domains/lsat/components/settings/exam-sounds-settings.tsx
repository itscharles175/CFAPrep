import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  getExamSoundsEnabled,
  playSectionEndBeep,
  setExamSoundsEnabled,
} from "@/lib/examSounds";
import { toast } from "@/lib/toast";

export function ExamSoundsSettings() {
  const [on, setOn] = useState(() => getExamSoundsEnabled());

  function save(next: boolean) {
    setOn(next);
    setExamSoundsEnabled(next);
    toast.success(next ? "Exam sounds on" : "Exam sounds off");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exam sounds</CardTitle>
        <CardDescription>
          Optional short chime when a timed section ends. Off by default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="exam-sounds">Section end chime</Label>
          <Switch
            id="exam-sounds"
            aria-label="Toggle section end chime"
            checked={on}
            onCheckedChange={(v) => save(v)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!on}
          onClick={() => playSectionEndBeep()}
        >
          Preview sound
        </Button>
      </CardContent>
    </Card>
  );
}
