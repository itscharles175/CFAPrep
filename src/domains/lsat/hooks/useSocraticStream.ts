// LSAT-4 — live Socratic tutor stream hook.
//
// Wraps the SSE turn endpoint (`api.addTutorTurnStream`, which builds on the
// unified BB2 streaming client `src/lib/streamingClient.ts`) into a small,
// component-friendly surface:
//
//   { turns, streamingText, citations, isStreaming, error, sendTurn, abort }
//
// The flow it drives is the nudge -> eliminate -> confirm -> explain Socratic
// loop: the student commits a prediction (a turn), the tutor streams a nudge
// that cites the retrieved similar-misses + Notebook artifacts behind it, never
// revealing the answer key. `sendTurn` optimistically appends the user turn,
// streams the assistant reply token-by-token into `streamingText`, then commits
// the finalized assistant turn + its citations on the done frame.
//
// Cancellation: each send owns an AbortController. A NEW `sendTurn` while one is
// in flight aborts the prior stream first (so a mid-stream re-send is safe and
// never interleaves two replies); `abort()` cancels the current stream. An
// aborted stream is silent — it surfaces neither a token nor an error.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@lsat/lib/api";
import type {
  SocraticCitation,
  SocraticEvidence,
  SocraticTurn,
  TutorSocraticContext,
  TutorTurnRecord,
} from "@lsat/lib/types";

/** Project a streamed/persisted `TutorTurnRecord` onto the hook's turn shape. */
function toSocraticTurn(record: TutorTurnRecord): SocraticTurn {
  return {
    id: record.id,
    role: record.role === "assistant" ? "assistant" : "user",
    content: record.content,
    context: record.meta?.socratic_context,
  };
}

/** Flatten a Socratic context into the inline citation badges the UI renders. */
export function citationsFromContext(
  context: TutorSocraticContext | undefined,
): SocraticCitation[] {
  if (!context) return [];
  const out: SocraticCitation[] = [];
  for (const miss of context.similar_misses ?? []) {
    out.push({
      kind: "similar_miss",
      label: `Q${miss.question_id}`,
      detail:
        miss.trap_guess ?? miss.trap_type ?? miss.q_type ?? miss.matched_by ?? undefined,
      questionId: miss.question_id,
    });
  }
  for (const item of context.notebook_context?.items ?? []) {
    out.push({
      kind: "notebook",
      label: item.title,
      detail: item.excerpt ?? item.source ?? undefined,
      id: item.id,
    });
  }
  return out;
}

export interface UseSocraticStreamResult {
  /** Committed turns (user + finalized assistant replies), in order. */
  turns: SocraticTurn[];
  /** The assistant reply text as it streams in (empty when idle). */
  streamingText: string;
  /** Inline citation badges for the most recent assistant reply / loaded evidence. */
  citations: SocraticCitation[];
  /** True while a reply is streaming. */
  isStreaming: boolean;
  /** A non-abort failure from the last stream, else null. */
  error: Error | null;
  /** Send a user turn and stream the Socratic reply. Aborts any in-flight send. */
  sendTurn: (content: string) => Promise<void>;
  /** Cancel the in-flight stream (if any). Safe to call when idle. */
  abort: () => void;
}

/**
 * Drive a live Socratic conversation against `conversationId`.
 *
 * `initialTurns` seeds the committed transcript (e.g. the turns already loaded
 * by the React-Query conversation fetch) so the hook renders history before the
 * first live send. Passing `null` for `conversationId` disables sending.
 */
export function useSocraticStream(
  conversationId: number | null,
  initialTurns: TutorTurnRecord[] = [],
): UseSocraticStreamResult {
  const [turns, setTurns] = useState<SocraticTurn[]>(() =>
    initialTurns.map(toSocraticTurn),
  );
  const [streamingText, setStreamingText] = useState("");
  const [citations, setCitations] = useState<SocraticCitation[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track the in-flight stream's controller + the conversation it belongs to, so
  // a conversation switch or a re-send aborts the prior stream cleanly.
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<number | null>(conversationId);
  convRef.current = conversationId;

  // Reseed the transcript when the active conversation changes (and drop any
  // in-flight stream + transient state for the old conversation).
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns(initialTurns.map(toSocraticTurn));
    setStreamingText("");
    setCitations([]);
    setIsStreaming(false);
    setError(null);
    // We intentionally key only on conversationId: initialTurns is a fresh array
    // each render, so depending on it would reset the transcript on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreamingText("");
  }, []);

  const sendTurn = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      const convId = convRef.current;
      if (!convId || !trimmed) return;

      // A re-send mid-stream: abort the prior stream so two replies never
      // interleave, then open a fresh controller for this send.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setIsStreaming(true);
      setStreamingText("");
      // Optimistically append the user's turn (a temporary client id; the server
      // record replaces nothing — the user turn is not re-rendered from the done
      // frame, only the assistant reply is committed below).
      setTurns((prev) => [
        ...prev,
        { id: -Date.now(), role: "user", content: trimmed },
      ]);

      let acc = "";
      await api.addTutorTurnStream(
        convId,
        { role: "user", content: trimmed, auto_reply: true },
        {
          signal: controller.signal,
          onToken: (token) => {
            // Ignore late tokens from a superseded stream.
            if (abortRef.current !== controller) return;
            acc += token;
            setStreamingText(acc);
          },
          onDone: (meta) => {
            if (abortRef.current !== controller) return;
            const reply = meta?.reply;
            const replyCtx = meta?.socratic_context ?? reply?.meta?.socratic_context;
            if (reply) {
              setTurns((prev) => [...prev, toSocraticTurn(reply)]);
            } else if (acc.trim()) {
              // Defensive: stream had tokens but no reply record — commit the text.
              setTurns((prev) => [
                ...prev,
                { id: -Date.now(), role: "assistant", content: acc },
              ]);
            }
            setCitations(citationsFromContext(replyCtx));
            setStreamingText("");
            setIsStreaming(false);
            abortRef.current = null;
          },
          onError: (err) => {
            if (abortRef.current !== controller) return;
            setError(err);
            setStreamingText("");
            setIsStreaming(false);
            abortRef.current = null;
          },
        },
      );
    },
    [],
  );

  // Tear down any live stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { turns, streamingText, citations, isStreaming, error, sendTurn, abort };
}

/** Fetch the standalone citable evidence for a conversation (read-only). */
export async function fetchSocraticEvidence(
  conversationId: number,
): Promise<SocraticEvidence> {
  return api.getConversationEvidence(conversationId);
}
