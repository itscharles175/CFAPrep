import { useEffect, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Target } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Label } from "@lsat/components/ui/label";
import { Input } from "@lsat/components/ui/input";
import { Switch } from "@lsat/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@lsat/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lsat/components/ui/select";
import { PageLayout } from "@lsat/components/page-layout";
import { Icon } from "@lsat/components/ui/icon";
import { TrapSpiralCard } from "@lsat/components/drills/trap-spiral-card";
import { setDrillTimeCapMin } from "@lsat/lib/drillPrefs";
import { ErrorState } from "@lsat/components/states";
import { api } from "@lsat/lib/api";
import { toast } from "@lsat/lib/toast";
import { useCreateDrill } from "@lsat/lib/mutations";
import { qTypeLabel } from "@lsat/lib/labels";
import type {
  DrillConfig,
  LrType,
  RcType,
  SectionType,
} from "@lsat/lib/types";

const LR_TYPES: LrType[] = [
  "MainPoint", "NecessaryAssumption", "SufficientAssumption", "Strengthen",
  "Weaken", "Flaw", "Inference", "MostStronglySupported", "PrincipleApply",
  "PrincipleIdentify", "Parallel", "ParallelFlaw", "Method", "Role",
  "PointAtIssue", "Paradox", "Evaluate",
];
const RC_TYPES: RcType[] = [
  "MainPoint", "Attitude", "Detail", "Inference", "Function", "Structure",
  "Application", "StrengthenWeaken", "Comparative",
];

export default function Drills() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sectionType, setSectionType] = useState<SectionType>("LR");
  const [qType, setQType] = useState<string>("any");
  const [difficulty, setDifficulty] = useState<string>("any");
  const [count, setCount] = useState(10);
  const [source, setSource] = useState<DrillConfig["source"]>("real");
  const [timed, setTimed] = useState(true);
  const [timeCapMin, setTimeCapMin] = useState<number | "">("");
  const createDrill = useCreateDrill();
  const [err, setErr] = useState<string | null>(null);
  const [intentText, setIntentText] = useState("");
  const [intentBusy, setIntentBusy] = useState(false);

  const types = sectionType === "LR" ? LR_TYPES : RC_TYPES;

  // A8 — natural-language drill spec ("3 harder Parallel, official only") parsed
  // server-side into a DrillConfig, then applied to the form for review.
  async function applyIntent() {
    if (!intentText.trim()) return;
    setIntentBusy(true);
    try {
      const cfg = await api.drillIntent(intentText.trim());
      if (cfg.section_type) setSectionType(cfg.section_type);
      setQType(cfg.q_type ? String(cfg.q_type) : "any");
      setDifficulty(cfg.difficulty != null ? String(cfg.difficulty) : "any");
      if (cfg.count) setCount(Math.max(1, Math.min(50, cfg.count)));
      if (cfg.source) setSource(cfg.source);
      setTimed(cfg.timed);
      toast.success("Parsed — review and start your drill");
    } catch {
      toast.error("Couldn't parse that — set the options manually");
    } finally {
      setIntentBusy(false);
    }
  }

  useEffect(() => {
    const qt = searchParams.get("q_type");
    if (qt) {
      if (LR_TYPES.includes(qt as LrType)) {
        setSectionType("LR");
        setQType(qt);
      } else if (RC_TYPES.includes(qt as RcType)) {
        setSectionType("RC");
        setQType(qt);
      }
    }
    const c = searchParams.get("count");
    if (c) {
      const n = Number(c);
      if (n >= 1 && n <= 50) setCount(n);
    }
    if (searchParams.get("untimed") === "1") setTimed(false);
  }, [searchParams]);

  function start() {
    setErr(null);
    const config: DrillConfig = {
      section_type: sectionType,
      q_type: qType === "any" ? undefined : qType,
      difficulty: difficulty === "any" ? undefined : Number(difficulty),
      count,
      source,
      timed,
    };
    if (timed && timeCapMin !== "" && timeCapMin > 0) {
      setDrillTimeCapMin(timeCapMin);
    } else {
      setDrillTimeCapMin(null);
    }
    createDrill.mutate(config, {
      onSuccess: (res) => {
        // Play the drill's curated set via the session runner — these questions
        // belong to no Section, so the runner loads them from the StudySession
        // (GET /sessions/{id}/questions) rather than /sections/:id.
        navigate(`/take/session/${res.session_id}`);
      },
      onError: () => {
        setErr("Couldn't build that drill — the backend may be offline. Try again.");
      },
    });
  }

  return (
    <PageLayout
      title="Drills"
      eyebrow="Targeted practice"
      icon={Target}
      description="Build a focused set by type and difficulty."
      width="md"
    >
      {err && (
        <ErrorState
          error={new Error(err)}
          onRetry={() => setErr(null)}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon as={Target} size="md" /> Build a drill set
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Describe it (optional)">
            {(id) => (
            <div className="flex gap-2">
              <Input
                id={id}
                value={intentText}
                placeholder="e.g. 3 harder Parallel, official only"
                onChange={(e) => setIntentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyIntent();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={intentBusy || !intentText.trim()}
                onClick={() => void applyIntent()}
              >
                {intentBusy ? "Parsing…" : "Build"}
              </Button>
            </div>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Section">
              {(id) => (
              <Select
                value={sectionType}
                onValueChange={(v) => {
                  setSectionType(v as SectionType);
                  setQType("any");
                }}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LR">Logical Reasoning</SelectItem>
                  <SelectItem value="RC">Reading Comprehension</SelectItem>
                </SelectContent>
              </Select>
              )}
            </Field>
            <Field label="Question type">
              {(id) => (
              <Select value={qType} onValueChange={setQType}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any type</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {qTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </Field>
            <Field label="Difficulty">
              {(id) => (
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {"★".repeat(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </Field>
            <Field label="Count">
              {(id) => (
              <Select
                value={String(count)}
                onValueChange={(v) => setCount(Number(v))}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[5, 10, 15, 20, 25].map((c) => (
                    <SelectItem key={c} value={String(c)}>
                      {c} questions
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </Field>
          </div>

          <Field label="Source">
            {(id) => (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={source}
              onValueChange={(v) => v && setSource(v as DrillConfig["source"])}
              className="justify-start"
              aria-labelledby={`${id}-label`}
            >
              <ToggleGroupItem value="real">Real only</ToggleGroupItem>
              <ToggleGroupItem value="ai">AI-generated</ToggleGroupItem>
              <ToggleGroupItem value="any">Any</ToggleGroupItem>
            </ToggleGroup>
            )}
          </Field>

          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={timed}
              onCheckedChange={setTimed}
              aria-label="Timed drill"
            />
            Timed
          </div>

          {timed && (
            <Field label="Time cap (minutes, optional)">
              {(id) => (
              <Select
                value={timeCapMin === "" ? "none" : String(timeCapMin)}
                onValueChange={(v) =>
                  setTimeCapMin(v === "none" ? "" : Number(v))
                }
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Section default</SelectItem>
                  {[10, 15, 20, 25, 35].map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m} minutes
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
            </Field>
          )}

          <Button className="w-full" onClick={start} disabled={createDrill.isPending}>
            {createDrill.isPending ? "Building…" : "Start drill"}
          </Button>
        </CardContent>
      </Card>

      <TrapSpiralCard />
    </PageLayout>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      {children(id)}
    </div>
  );
}
