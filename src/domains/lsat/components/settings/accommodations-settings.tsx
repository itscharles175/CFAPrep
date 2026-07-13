import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import { Switch } from "@lsat/components/ui/switch";
import {
  getAccommodations,
  setAccommodations,
  type Accommodations,
} from "@lsat/lib/prefs";
import { toast } from "@lsat/lib/toast";
import { ExamSoundsSettings } from "@lsat/components/settings/exam-sounds-settings";

export function AccommodationsSettings() {
  const [acc, setAcc] = useState<Accommodations>(() => getAccommodations());

  function save() {
    setAccommodations(acc);
    toast.success("Accommodations saved");
  }

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accommodations</CardTitle>
        <CardDescription>
          Extra time and break length apply to timed sections and full exams.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="extra-time">Extra time (%)</Label>
            <Input
              id="extra-time"
              type="number"
              min={0}
              max={100}
              value={acc.extraTimePct}
              onChange={(e) =>
                setAcc((a) => ({ ...a, extraTimePct: Number(e.target.value) }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="break-min">Break length (minutes)</Label>
            <Input
              id="break-min"
              type="number"
              min={5}
              max={30}
              value={acc.breakMin}
              onChange={(e) =>
                setAcc((a) => ({ ...a, breakMin: Number(e.target.value) }))
              }
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="hide-timer">Hide timer by default</Label>
            <p className="text-xs text-muted-foreground">
              You can still show the timer during a section.
            </p>
          </div>
          <Switch
            id="hide-timer"
            aria-label="Hide timer by default"
            checked={acc.hideTimerDefault}
            onCheckedChange={(v) => setAcc((a) => ({ ...a, hideTimerDefault: v }))}
          />
        </div>
        <Button size="sm" onClick={save}>
          Save accommodations
        </Button>
      </CardContent>
    </Card>
    <ExamSoundsSettings />
    </>
  );
}
