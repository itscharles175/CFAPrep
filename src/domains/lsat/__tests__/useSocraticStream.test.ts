import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the API client so the hook drives a controllable fake stream rather than
// hitting fetch. The hook only depends on `addTutorTurnStream` + (for the helper)
// `getConversationEvidence`, so a tiny mock object is enough.
const addTutorTurnStream = vi.fn();
const getConversationEvidence = vi.fn();
vi.mock("@lsat/lib/api", () => ({
  api: {
    addTutorTurnStream: (...args: unknown[]) => addTutorTurnStream(...args),
    getConversationEvidence: (...args: unknown[]) =>
      getConversationEvidence(...args),
  },
}));

import {
  citationsFromContext,
  fetchSocraticEvidence,
  useSocraticStream,
} from "../hooks/useSocraticStream";
import type { TutorSocraticContext, TutorTurnRecord } from "@lsat/lib/types";

const assistantReply: TutorTurnRecord = {
  id: 99,
  conversation_id: 1,
  role: "assistant",
  content: "Before revealing anything, name the gap. ",
  meta: {
    local_only: true,
    model: "deterministic_socratic_v2_stream",
    socratic_context: {
      answer_key_hidden: true,
      prior_turn_count: 1,
      similar_misses: [
        { question_id: 42, q_type: "Flaw", trap_guess: "scope_shift" },
      ],
      notebook_context: {
        count: 1,
        items: [{ kind: "note", id: 7, title: "Scope shift notebook" }],
      },
    },
  },
  created_at: "2026-06-17T00:00:00Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSocraticStream", () => {
  it("streams tokens into streamingText then commits the assistant turn + citations", async () => {
    // Fake stream: emit two tokens, then a done frame carrying the reply + ctx.
    addTutorTurnStream.mockImplementation(async (_id, _body, handlers) => {
      handlers.onToken("Before revealing anything, ");
      handlers.onToken("name the gap. ");
      handlers.onDone({
        turn: { id: 98, conversation_id: 1, role: "user", content: "stuck", meta: {}, created_at: "" },
        reply: assistantReply,
        socratic_context: assistantReply.meta.socratic_context,
      });
    });

    const { result } = renderHook(() => useSocraticStream(1));

    await act(async () => {
      await result.current.sendTurn("Why is my answer wrong?");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    // The user turn was appended optimistically; the assistant reply committed.
    const roles = result.current.turns.map((t) => t.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(result.current.turns[0].content).toBe("Why is my answer wrong?");
    expect(result.current.turns[1].content).toBe(assistantReply.content);
    // streamingText cleared once committed.
    expect(result.current.streamingText).toBe("");
    // Citations flattened from the done-frame context.
    expect(result.current.citations).toEqual([
      { kind: "similar_miss", label: "Q42", detail: "scope_shift", questionId: 42 },
      { kind: "notebook", label: "Scope shift notebook", detail: undefined, id: 7 },
    ]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a stream error and clears the streaming state", async () => {
    addTutorTurnStream.mockImplementation(async (_id, _body, handlers) => {
      handlers.onToken("partial ");
      handlers.onError(new Error("socratic_stream_failed"));
    });

    const { result } = renderHook(() => useSocraticStream(1));
    await act(async () => {
      await result.current.sendTurn("Help");
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("socratic_stream_failed");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingText).toBe("");
    // No assistant turn was committed (only the optimistic user turn remains).
    expect(result.current.turns.map((t) => t.role)).toEqual(["user"]);
  });

  it("aborts the prior stream when a new sendTurn fires mid-stream", async () => {
    const signals: AbortSignal[] = [];
    // First call: never resolves its done (simulating an in-flight stream); it
    // captures the signal so we can assert it was aborted by the second send.
    addTutorTurnStream
      .mockImplementationOnce(async (_id, _body, handlers) => {
        signals.push(handlers.signal);
        handlers.onToken("first ");
        // Do NOT call onDone — leaves the stream "open".
      })
      .mockImplementationOnce(async (_id, _body, handlers) => {
        signals.push(handlers.signal);
        handlers.onDone({ reply: assistantReply, socratic_context: assistantReply.meta.socratic_context });
      });

    const { result } = renderHook(() => useSocraticStream(1));
    await act(async () => {
      await result.current.sendTurn("first question");
    });
    await act(async () => {
      await result.current.sendTurn("second question");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    // The first send's controller was aborted before the second opened.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    // Two user turns appended; one assistant reply (from the second stream).
    expect(result.current.turns.map((t) => t.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });

  it("abort() cancels the in-flight stream and clears streaming text", async () => {
    // A holder object avoids TS narrowing a closure-mutated `let` to `never`.
    const holder: { signal: AbortSignal | null } = { signal: null };
    addTutorTurnStream.mockImplementation(async (_id, _body, handlers) => {
      holder.signal = handlers.signal as AbortSignal;
      handlers.onToken("streaming... ");
      // leave open
    });

    const { result } = renderHook(() => useSocraticStream(1));
    await act(async () => {
      await result.current.sendTurn("question");
    });
    expect(result.current.streamingText).toBe("streaming... ");

    act(() => result.current.abort());
    expect(holder.signal?.aborted).toBe(true);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingText).toBe("");
  });

  it("does not send when conversationId is null or content is blank", async () => {
    const { result } = renderHook(() => useSocraticStream(null));
    await act(async () => {
      await result.current.sendTurn("ignored");
    });
    expect(addTutorTurnStream).not.toHaveBeenCalled();

    const { result: r2 } = renderHook(() => useSocraticStream(1));
    await act(async () => {
      await r2.current.sendTurn("   ");
    });
    expect(addTutorTurnStream).not.toHaveBeenCalled();
  });

  it("seeds the transcript from initialTurns", () => {
    const seeded: TutorTurnRecord[] = [
      { id: 1, conversation_id: 1, role: "user", content: "earlier", meta: {}, created_at: "" },
      assistantReply,
    ];
    const { result } = renderHook(() => useSocraticStream(1, seeded));
    expect(result.current.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(result.current.turns[0].content).toBe("earlier");
  });
});

describe("citationsFromContext", () => {
  it("returns an empty array for undefined context", () => {
    expect(citationsFromContext(undefined)).toEqual([]);
  });

  it("flattens similar misses and notebook items", () => {
    const ctx: TutorSocraticContext = {
      answer_key_hidden: true,
      prior_turn_count: 0,
      similar_misses: [{ question_id: 5, trap_type: "false_dichotomy" }],
      notebook_context: { count: 1, items: [{ kind: "note", id: 3, title: "Memo" }] },
    };
    expect(citationsFromContext(ctx)).toEqual([
      { kind: "similar_miss", label: "Q5", detail: "false_dichotomy", questionId: 5 },
      { kind: "notebook", label: "Memo", detail: undefined, id: 3 },
    ]);
  });
});

describe("fetchSocraticEvidence", () => {
  it("delegates to api.getConversationEvidence", async () => {
    const evidence = {
      conversation_id: 1,
      question_id: 2,
      answer_key_hidden: true,
      prior_turn_count: 0,
      recent_turns: [],
      question_context: {},
      similar_misses: [],
      notebook_context: { count: 0, items: [] },
    };
    getConversationEvidence.mockResolvedValue(evidence);
    await expect(fetchSocraticEvidence(1)).resolves.toEqual(evidence);
    expect(getConversationEvidence).toHaveBeenCalledWith(1);
  });
});
