import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { m, AnimatePresence, useReducedMotion } from "motion/react";
import { MessageSquareText, RefreshCw, Send, X, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { Textarea } from "@lsat/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lsat/components/ui/tabs";
import { useCoach } from "@lsat/lib/hooks";
import { useRefreshCoach, useCoachChat } from "@lsat/lib/mutations";
import { getRaw, setRaw } from "@lsat/lib/storage";
import { duration, easing } from "@lsat/lib/motion";
import { timeAgo } from "@lsat/lib/utils";
import type { ChatTurn, Recommendation } from "@lsat/lib/types";

// Map a coach recommendation to an in-app route. The backend coach emits
// `action.type` of drill / srs / analytics / blind_review / start_section.
function recPath(rec: Recommendation): string {
  const p = rec.action.payload ?? {};
  switch (rec.action.type) {
    case "drill":
      return `/drills?q_type=${encodeURIComponent(String(p.q_type ?? ""))}`;
    case "srs":
      return "/srs";
    case "analytics":
      return "/analytics";
    case "blind_review":
      return "/review";
    case "start_section":
      return "/practice";
    default:
      return "/practice";
  }
}

export { recPath };

// Number of trailing turns sent as conversation context (≈6 per the spec).
const HISTORY_TURNS = 6;

/**
 * A7 / X3 — collapsible right-rail tutor for study-mode surfaces (Review,
 * Explanation). The "Snapshot" tab surfaces the cached coach diagnosis + its
 * recommendation and keeps a session-scoped notes pad. The "Chat" tab is a real
 * conversation backed by POST /ai/coach/chat — the transcript lives in
 * component state and the last few turns are sent as `history` for context.
 */
export function DockedCoach({ scope = "global" }: { scope?: string }) {
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const coach = useCoach();
  const refresh = useRefreshCoach();
  const chat = useCoachChat();
  const snap = coach.data?.data;

  const openKey = "lsatlab.coach.docked.open";
  const notesKey = `lsatlab.coach.notes.${scope}`;
  const [open, setOpen] = useState<boolean>(() => getRaw(openKey) === "1");
  const [notes, setNotes] = useState<string>(() => getRaw(notesKey) ?? "");
  const [tab, setTab] = useState<"snapshot" | "chat">("snapshot");

  // Chat transcript is session-scoped (in-memory) per the spec.
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRaw(openKey, open ? "1" : "0");
  }, [open]);
  useEffect(() => {
    const id = setTimeout(() => setRaw(notesKey, notes), 400);
    return () => clearTimeout(id);
  }, [notes, notesKey]);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    if (tab !== "chat") return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chat.isPending, tab]);

  function sendChat() {
    const text = draft.trim();
    if (!text || chat.isPending) return;
    const next: ChatTurn[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    chat.mutate(
      { message: text, history: next.slice(-1 - HISTORY_TURNS, -1) },
      {
        onSuccess: (res) =>
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: res.reply },
          ]),
      },
    );
  }

  return (
    <>
      {/* Toggle */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="lsat-docked-coach-trigger fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-e3 transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring print:hidden"
          aria-label="Open coach"
        >
          <Icon as={MessageSquareText} size="md" />
          {snap?.available && (
            <span className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-background bg-success" />
          )}
        </button>
      )}

      <AnimatePresence>
        {open && (
          <m.aside
            key="docked-coach"
            initial={reduce ? false : { x: 360, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { x: 360, opacity: 0 }}
            transition={{ type: "tween", duration: duration.base, ease: easing.emphasized }}
            className="lsat-docked-coach-panel fixed bottom-6 right-6 z-40 flex max-h-[80vh] w-80 flex-col overflow-hidden rounded-card border bg-card shadow-e3 print:hidden"
            role="complementary"
            aria-label="Coach"
          >
            <header className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="flex items-center gap-2 font-medium">
                <Icon as={MessageSquareText} size="sm" className="text-primary" /> Coach
              </span>
              <div className="flex items-center gap-1">
                {tab === "snapshot" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-10 w-10"
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate()}
                    aria-label="Re-diagnose"
                    title="Re-diagnose"
                  >
                    <RefreshCw className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10"
                  onClick={() => setOpen(false)}
                  aria-label="Close coach"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </header>

            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "snapshot" | "chat")}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-4 mt-3 grid h-9 grid-cols-2">
                <TabsTrigger value="snapshot">Snapshot</TabsTrigger>
                <TabsTrigger value="chat">Chat</TabsTrigger>
              </TabsList>

              {/* --- Snapshot + session notes (existing behavior) --- */}
              <TabsContent
                value="snapshot"
                className="mt-3 flex-1 space-y-3 overflow-y-auto p-4 pt-0 text-sm"
              >
                {snap?.available ? (
                  <>
                    <p className="type-counsel whitespace-pre-line text-[15px] leading-relaxed text-foreground">
                      {snap.text}
                    </p>
                    {snap.recommendation && (
                      <Button
                        size="sm"
                        className="w-full justify-between"
                        onClick={() => navigate(recPath(snap.recommendation!))}
                      >
                        {snap.recommendation.label}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    )}
                    {snap.created_at && (
                      <p className="text-2xs text-muted-foreground">
                        Updated {timeAgo(snap.created_at)}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="type-counsel text-muted-foreground">
                    No diagnosis yet. Tap refresh to analyze your recent work, or
                    switch to Chat to ask a question.
                  </p>
                )}

                <div className="space-y-1.5 border-t pt-3">
                  <label htmlFor="coach-notes" className="type-overline text-muted-foreground">
                    Session notes
                  </label>
                  <Textarea
                    id="coach-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={4}
                    placeholder="Jot what you notice as you review — saved for this session."
                    className="resize-none text-sm"
                  />
                </div>
              </TabsContent>

              {/* --- Chat transcript + composer (X3) --- */}
              <TabsContent
                value="chat"
                className="mt-3 flex min-h-0 flex-1 flex-col p-0"
              >
                <div
                  ref={transcriptRef}
                  className="flex-1 space-y-2 overflow-y-auto px-4 text-sm"
                  role="log"
                  aria-live="polite"
                  aria-label="Coach chat transcript"
                >
                  {messages.length === 0 && !chat.isPending && (
                    <p className="type-counsel py-2 text-muted-foreground">
                      Ask the coach anything about your practice — a concept, a
                      trap you keep hitting, or how to spend today&apos;s study
                      time.
                    </p>
                  )}
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={
                        m.role === "user"
                          ? "ml-auto w-fit max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground"
                          : "type-counsel mr-auto w-fit max-w-[85%] whitespace-pre-line rounded-lg bg-muted px-3 py-2 leading-relaxed text-foreground"
                      }
                    >
                      {m.content}
                    </div>
                  ))}
                  {chat.isPending && (
                    <div className="mr-auto flex w-fit items-center gap-2 rounded-lg bg-muted px-3 py-2 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Thinking…
                    </div>
                  )}
                </div>
                <form
                  className="flex items-end gap-2 border-t p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendChat();
                  }}
                >
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                    rows={1}
                    placeholder="Message the coach… (Enter to send)"
                    aria-label="Message the coach"
                    className="max-h-24 min-h-9 resize-none text-sm"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    disabled={!draft.trim() || chat.isPending}
                    aria-label="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </m.aside>
        )}
      </AnimatePresence>
    </>
  );
}
