import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, BrainCircuit, MessageSquare, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageLayout, PageSection } from "@lsat/components/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lsat/components/ui/select";
import { Textarea } from "@lsat/components/ui/textarea";
import { Badge } from "@lsat/components/ui/badge";
import { api } from "@lsat/lib/api";
import { useAdaptivityPlan, useReadinessStatus } from "@lsat/lib/hooks";
import type { TutorSocraticContext } from "@lsat/lib/types";

export function SocraticEvidence({
  context,
}: {
  context?: TutorSocraticContext;
}) {
  const similar = context?.similar_misses ?? [];
  const notebook = context?.notebook_context?.items ?? [];
  const recentTurns = context?.recent_turns ?? [];
  const question = context?.question_context;
  const hasQuestionContext = Boolean(
    question?.section_type === "RC" || question?.passage_excerpt,
  );
  const hasTurnContext = Boolean(context?.prior_turn_count || recentTurns.length);
  if (!similar.length && !notebook.length && !hasQuestionContext && !hasTurnContext) return null;
  return (
    <div className="mt-3 space-y-3 rounded-md bg-muted/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Why this nudge</p>
        <div className="flex flex-wrap gap-1.5">
          {context?.answer_key_hidden ? (
            <Badge variant="success" className="text-[11px]">
              Answer hidden
            </Badge>
          ) : null}
          {hasTurnContext ? (
            <Badge variant="outline" className="text-[11px]">
              {context?.prior_turn_count ?? recentTurns.length} persisted turn{(context?.prior_turn_count ?? recentTurns.length) === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {hasQuestionContext ? (
          <Badge
            variant="secondary"
            className="max-w-full text-[11px]"
            title={question?.passage_excerpt ?? question?.stem_excerpt ?? undefined}
          >
            {question?.section_type ?? "Question"}
            {question?.passage_topic ? ` · ${question.passage_topic}` : ""}
          </Badge>
        ) : null}
        {similar.slice(0, 3).map((miss) => (
          <Badge
            key={`miss-${miss.question_id}-${miss.trap_guess ?? miss.trap_type ?? miss.matched_by ?? "match"}`}
            variant="outline"
            className="max-w-full text-[11px]"
            title={miss.rationale_excerpt ?? miss.note_excerpt ?? undefined}
          >
            Q{miss.question_id}
            {miss.q_type ? ` · ${miss.q_type}` : ""}
            {miss.trap_guess ?? miss.trap_type
              ? ` · ${miss.trap_guess ?? miss.trap_type}`
              : ""}
          </Badge>
        ))}
        {notebook.slice(0, 3).map((item) => (
          <Badge
            key={`notebook-${item.kind}-${item.id}`}
            variant="secondary"
            className="max-w-full text-[11px]"
            title={item.excerpt ?? item.title}
          >
            Notebook · {item.title}
          </Badge>
        ))}
      </div>
      {question?.passage_excerpt ? (
        <div className="rounded border bg-background/60 p-2 text-xs">
          <p className="font-medium text-foreground">Passage-aware context</p>
          <p className="mt-1 line-clamp-3 text-muted-foreground">
            {question.passage_excerpt}
          </p>
        </div>
      ) : null}
      {similar.length ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Trap-similar misses</p>
          {similar.slice(0, 3).map((miss) => {
            const match = miss.matched_by?.replace(/_/g, " ") ?? "similar";
            const score =
              typeof miss.similarity === "number"
                ? ` · ${Math.round(miss.similarity * 100)}%`
                : "";
            const excerpt = miss.rationale_excerpt ?? miss.note_excerpt;
            return (
              <div
                key={`miss-detail-${miss.question_id}-${miss.trap_guess ?? miss.trap_type ?? match}`}
                className="rounded border bg-background/60 p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">Q{miss.question_id}</Badge>
                  {miss.q_type ? <Badge variant="secondary">{miss.q_type}</Badge> : null}
                  {miss.trap_guess ?? miss.trap_type ? (
                    <Badge variant="warning">{miss.trap_guess ?? miss.trap_type}</Badge>
                  ) : null}
                  <span className="text-muted-foreground">
                    matched by {match}{score}
                  </span>
                </div>
                {excerpt ? (
                  <p className="mt-1 line-clamp-2 text-muted-foreground">{excerpt}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {recentTurns.length ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Persisted turn context</p>
          {recentTurns.slice(-2).map((turn, index) => (
            <p
              key={`${turn.role}-${index}-${turn.content.slice(0, 12)}`}
              className="line-clamp-2 rounded border bg-background/60 p-2 text-xs text-muted-foreground"
            >
              <span className="font-medium text-foreground">{turn.role}:</span>{" "}
              {turn.content}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Tutor() {
  const qc = useQueryClient();
  const [attemptId, setAttemptId] = useState("");
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<"sure" | "likely" | "guess">("likely");
  const [rationale, setRationale] = useState("");
  const [trapGuess, setTrapGuess] = useState("out_of_scope");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [turn, setTurn] = useState("");
  const attemptNumber = Number(attemptId);
  const plan = useAdaptivityPlan(60);
  const readiness = useReadinessStatus();
  const why = useQuery({
    queryKey: ["why-loop", attemptNumber],
    queryFn: () => api.whyLoop(attemptNumber),
    enabled: Number.isFinite(attemptNumber) && attemptNumber > 0,
  });
  const conversations = useQuery({
    queryKey: ["conversations", why.data?.question_id ?? "none"],
    queryFn: () => api.conversations(why.data?.question_id),
    enabled: !!why.data?.question_id,
  });

  async function saveRationale() {
    if (!why.data || !rationale.trim()) return;
    await api.saveRationale(why.data.attempt_id, {
      stage: "blind_review",
      answer: answer.trim().toUpperCase() || null,
      confidence,
      rationale_text: rationale,
      trap_guess: trapGuess || null,
    });
    await qc.invalidateQueries({ queryKey: ["why-loop", attemptNumber] });
    toast.success("Rationale saved");
  }

  async function startConversation() {
    if (!why.data) return;
    const conv = await api.createConversation({
      question_id: why.data.question_id,
      attempt_id: why.data.attempt_id,
      title: `${why.data.q_type ?? "Question"} why loop`,
    });
    setConversationId(conv.id);
    await qc.invalidateQueries({ queryKey: ["conversations", why.data.question_id] });
  }

  async function sendTurn() {
    if (!conversationId || !turn.trim()) return;
    await api.addTutorTurn(conversationId, { role: "user", content: turn, auto_reply: true });
    setTurn("");
    await qc.invalidateQueries({ queryKey: ["conversations", why.data?.question_id ?? "none"] });
  }

  async function createCards() {
    if (!why.data) return;
    const result = await api.createConceptCards(why.data.attempt_id);
    toast.success(`Concept cards: ${String(result.created ?? 0)} created`);
  }

  const activeConversation =
    (conversations.data ?? []).find((c) => c.id === conversationId) ??
    conversations.data?.[0];

  return (
    <PageLayout
      title="Tutor"
      eyebrow="Socratic Blind Review"
      icon={BrainCircuit}
      width="2xl"
      description="Local-only why loops, rationale memory, Socratic turns, and concept-gap remediation."
      actions={<Button variant="outline" onClick={createCards}><RotateCcw className="h-4 w-4" aria-hidden /> Create SRS cards</Button>}
    >
      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Why loop</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={attemptId}
                onChange={(e) => setAttemptId(e.target.value)}
                aria-label="Attempt ID"
                placeholder="Attempt ID"
              />
              <Button variant="outline" onClick={() => why.refetch()}>Load</Button>
            </div>
            <div className="grid gap-2">
              {(why.data?.steps ?? []).map((step) => (
                <div key={step.key} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <span>{step.key.replace(/_/g, " ")}</span>
                  <Badge variant={step.complete ? "success" : "outline"}>
                    {step.complete ? "done" : "next"}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="rounded-md bg-muted/45 p-3 text-sm">
              Next: <span className="font-medium">{why.data?.next_step?.replace(/_/g, " ") ?? "load an attempt"}</span>
            </div>
            <Textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Write why your answer is right before revealing anything."
              className="min-h-32"
            />
            <Input
              value={trapGuess}
              onChange={(e) => setTrapGuess(e.target.value)}
              placeholder="Trap guess"
              aria-label="Trap guess"
            />
            <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
              <Input
                value={answer}
                onChange={(e) => setAnswer(e.target.value.slice(0, 1).toUpperCase())}
                placeholder="Answer"
                aria-label="Blind Review answer"
              />
              <Select
                value={confidence}
                onValueChange={(value) => setConfidence(value as "sure" | "likely" | "guess")}
              >
                <SelectTrigger aria-label="Blind Review confidence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="guess">Guess</SelectItem>
                  <SelectItem value="likely">Likely</SelectItem>
                  <SelectItem value="sure">Sure</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={saveRationale} disabled={!rationale.trim() || !why.data || !attemptNumber}>
              Save rationale
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="h-4 w-4 text-primary" aria-hidden />
                Socratic conversation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={startConversation} disabled={!why.data}>
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  New local tutor loop
                </Button>
                {(conversations.data ?? []).map((conv) => (
                  <Button
                    key={conv.id}
                    size="sm"
                    variant={activeConversation?.id === conv.id ? "default" : "outline"}
                    onClick={() => setConversationId(conv.id)}
                  >
                    {conv.title}
                  </Button>
                ))}
              </div>
              <div className="space-y-2">
                {(activeConversation?.turns ?? []).map((t) => (
                  <div key={t.id} className="rounded-md border p-3 text-sm">
                    <Badge variant={t.role === "assistant" ? "secondary" : "outline"}>{t.role}</Badge>
                    <p className="mt-2 text-muted-foreground">{t.content}</p>
                    {t.role === "assistant" ? (
                      <SocraticEvidence context={t.meta?.socratic_context} />
                    ) : null}
                  </div>
                ))}
                {!activeConversation && (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Start a local tutor loop after loading an attempt.
                  </p>
                )}
              </div>
              <Textarea
                value={turn}
                onChange={(e) => setTurn(e.target.value)}
                placeholder="Ask for a Socratic hint without revealing the answer."
              />
              <Button onClick={sendTurn} disabled={!activeConversation || !turn.trim()}>
                Send
              </Button>
            </CardContent>
          </Card>

          <PageSection title="Adaptive signals" eyebrow="Plan">
            <div className="grid gap-3 md:grid-cols-2">
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Readiness</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {Math.round(readiness.data?.data.readiness_score ?? 0)}/100
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Next task</p>
                  <p className="mt-1 font-medium">
                    {plan.data?.data.tasks[0]?.label ?? "Build more evidence"}
                  </p>
                </CardContent>
              </Card>
            </div>
          </PageSection>
        </div>
      </div>
    </PageLayout>
  );
}
