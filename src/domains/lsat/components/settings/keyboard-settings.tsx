import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";
import {
  type ExamKeyAction,
  type KeyboardMap,
  actionLabel,
  getKeyboardMap,
  resetKeyboardMap,
  setKeyboardMap,
} from "@/lib/keyboardMap";

const ACTIONS: ExamKeyAction[] = [
  "answer_A",
  "answer_B",
  "answer_C",
  "answer_D",
  "answer_E",
  "flag",
  "prev",
  "next",
];

export function KeyboardSettings() {
  const [map, setMap] = useState<KeyboardMap>(() => getKeyboardMap());

  function save() {
    setKeyboardMap(map);
    toast.success("Keyboard shortcuts saved");
  }

  function reset() {
    setMap(resetKeyboardMap());
    toast.success("Restored defaults");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Keyboard shortcuts</CardTitle>
        <CardDescription>
          Customize exam keys. Shift + your E key still eliminates the selected choice.
          Press 1–9 to jump to a question (not rebindable).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {ACTIONS.map((action) => (
            <div key={action} className="flex items-center justify-between gap-3">
              <Label htmlFor={action} className="text-sm">
                {actionLabel(action)}
              </Label>
              <Input
                id={action}
                className="w-28 font-mono text-sm"
                value={map[action]}
                onChange={(e) =>
                  setMap((m) => ({ ...m, [action]: e.target.value }))
                }
                onKeyDown={(e) => {
                  e.preventDefault();
                  const k = e.key;
                  if (k === "Backspace") {
                    setMap((m) => ({ ...m, [action]: "" }));
                    return;
                  }
                  if (k.length === 1 || k.startsWith("Arrow")) {
                    setMap((m) => ({ ...m, [action]: k }));
                  }
                }}
                placeholder="Press a key…"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          ⌘/Ctrl+K opens the command palette · ? opens shortcut help (global, not customizable here).
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={save}>
            Save shortcuts
          </Button>
          <Button size="sm" variant="outline" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
