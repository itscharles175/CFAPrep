// Unified streaming client (BB2).
//
// Both domains stream text from a local model server, but they grew two
// separate transports:
//
//   - The host (`localLlm.js`) had NO streaming at all — `generateText` waited
//     for the whole completion, so a long generation looked frozen.
//   - The LSAT domain (`api.ts → streamExplain`) hand-rolled an SSE reader with
//     reconnect logic, but a stalled model surfaced as a generic 120s
//     CORS-looking failure with no distinct "the model wedged" signal.
//
// This module is the ONE transport both sides build on. It consumes a chunked
// `fetch` body — either Server-Sent Events (`data: {...}\n\n`) or a raw text
// stream — and emits four discrete event kinds:
//
//   - delta   : a token / text fragment arrived
//   - done    : the stream completed cleanly (optionally with metadata)
//   - timeout : the stream STALLED (no bytes for `stallTimeoutMs`, or the whole
//               request exceeded `totalTimeoutMs`) — DISTINCT from a network
//               error so the UI can say "the model is stuck" instead of a
//               CORS-looking "could not reach" message
//   - error   : a definitive, non-timeout failure (bad status, server-sent
//               error event, decode failure)
//
// The timeout machinery mirrors `localLlm.js`'s `fetchWithTimeout`/`isLlmTimeout`
// approach (an AbortController the caller can also drive). Here it is extended to
// cover the *body read* as well — a model that connects then stops emitting
// tokens trips the stall timer, which a connection-only timeout would miss.
//
// Two consumption styles are exposed so each caller adopts whichever fits:
//   - callback:        `streamSse(url, init, handlers)` / `streamRaw(...)`
//   - async-iterator:  `for await (const ev of streamEvents(url, init, opts))`

/** A discrete event emitted while consuming a stream. */
export type StreamEvent =
  /** A token / text fragment. `data` carries the parsed SSE object when SSE. */
  | { type: "delta"; text: string; data?: Record<string, unknown> }
  /** Clean completion. `meta` carries the final SSE object (e.g. ids), if any. */
  | { type: "done"; meta?: Record<string, unknown> }
  /** A stall/total-budget timeout — the model wedged, distinct from `error`. */
  | { type: "timeout"; error: StreamTimeoutError }
  /** A definitive, non-timeout failure. */
  | { type: "error"; error: Error };

/** Callback handlers mirroring {@link StreamEvent} for the non-iterator API. */
export interface StreamHandlers {
  onDelta?: (text: string, data?: Record<string, unknown>) => void;
  onDone?: (meta?: Record<string, unknown>) => void;
  /** Distinct from onError: the stream stalled / blew its time budget. */
  onTimeout?: (error: StreamTimeoutError) => void;
  onError?: (error: Error) => void;
}

export interface StreamOptions {
  /**
   * Abort the whole request if NO bytes arrive within this window. Resets on
   * every chunk, so it catches a model that connects then wedges mid-stream.
   * Set to 0 / undefined to disable the stall watchdog. Default: 60s.
   */
  stallTimeoutMs?: number;
  /**
   * Hard ceiling for the entire stream regardless of activity. Set to 0 /
   * undefined to disable. Default: disabled (a healthy long generation that
   * keeps emitting tokens should not be killed).
   */
  totalTimeoutMs?: number;
  /** Caller's own cancellation. Aborting it ends the stream silently. */
  signal?: AbortSignal;
  /**
   * Parse mode. "sse" (default) reads `data:`-prefixed Server-Sent Events;
   * "raw" treats every decoded chunk as a literal token (used when the server
   * streams bare text rather than SSE frames).
   */
  mode?: "sse" | "raw";
  /**
   * SSE field extractor. Given a parsed `data:` JSON object, return how it maps
   * onto stream events. The default handles the OpenAI-ish + LSAT shapes
   * (`{token}`, `{delta}`, `{choices:[{delta:{content}}]}`, `{done}`,
   * `{error}`, `[DONE]`). Override to plug a different wire shape in without
   * forking the reader.
   */
  parseSse?: SseParser;
}

/**
 * Maps a single parsed SSE `data:` payload onto a stream event. Returning
 * `null` ignores the frame (e.g. keep-alive). The reader handles the `[DONE]`
 * sentinel and non-JSON lines before this runs.
 */
export type SseParser = (
  payload: unknown,
) =>
  | { kind: "delta"; text: string; data?: Record<string, unknown> }
  | { kind: "done"; meta?: Record<string, unknown> }
  | { kind: "error"; message: string }
  | null;

/**
 * A timeout raised by the streaming client. Carries `isLlmTimeout` so it is
 * indistinguishable from `localLlm.js`'s own timeout flag at every call site
 * that already checks `error?.isLlmTimeout`, and `kind` to tell a no-connection
 * stall from a mid-stream stall from a total-budget overrun.
 */
export class StreamTimeoutError extends Error {
  /** Mirrors localLlm.js's timeout marker so existing `?.isLlmTimeout` checks fire. */
  readonly isLlmTimeout = true as const;
  readonly kind: "stall" | "total";
  readonly timeoutMs: number;
  constructor(kind: "stall" | "total", timeoutMs: number, cause?: unknown) {
    const seconds = Math.round(timeoutMs / 1000);
    super(
      kind === "stall"
        ? `The model stopped responding (no output for ${seconds}s). It may be overloaded or stuck — try again, pick a smaller model, or raise the limit.`
        : `The stream exceeded its ${seconds}s budget. The model may be overloaded — try again or pick a smaller model.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "StreamTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/** True for the unified timeout error OR any error carrying `isLlmTimeout`. */
export function isStreamTimeout(error: unknown): error is StreamTimeoutError {
  return (
    error instanceof StreamTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { isLlmTimeout?: unknown }).isLlmTimeout === true)
  );
}

/** True for a caller-initiated (or downstream) abort. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/** Default SSE field extractor (OpenAI-ish + LSAT shapes). */
const defaultParseSse: SseParser = (payload) => {
  if (typeof payload !== "object" || payload === null) {
    // A bare non-object JSON value (e.g. a quoted string): treat as a token.
    return { kind: "delta", text: String(payload) };
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.error === "string" && obj.error) {
    return { kind: "error", message: obj.error };
  }
  // OpenAI streaming chunk shape: choices[0].delta.content.
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)
      ?.delta;
    const content = delta?.content;
    if (typeof content === "string" && content) {
      return { kind: "delta", text: content, data: obj };
    }
    const finish = (choices[0] as { finish_reason?: unknown } | undefined)
      ?.finish_reason;
    if (finish) return { kind: "done", meta: obj };
  }
  if (typeof obj.token === "string" && obj.token) {
    return { kind: "delta", text: obj.token, data: obj };
  }
  if (typeof obj.delta === "string" && obj.delta) {
    return { kind: "delta", text: obj.delta, data: obj };
  }
  if (obj.done === true) {
    return { kind: "done", meta: obj };
  }
  // An object with no recognised field (e.g. a metadata-only frame): ignore.
  return null;
};

/**
 * The internal engine: open `url`, read its body to completion, and yield
 * {@link StreamEvent}s. Both the callback and async-iterator front-ends delegate
 * here. A timeout/abort is surfaced as a `timeout`/silent-stop event rather than
 * thrown, so a single consumer loop handles every outcome.
 *
 * Cancellation/timeout are wired through ONE AbortController:
 *   - the caller's `signal` (if any) forwards into it,
 *   - the stall watchdog and total-budget timer abort it,
 *   - we then disambiguate WHY it aborted (caller vs stall vs total) when the
 *     fetch/read rejects.
 */
export async function* streamEvents(
  url: string,
  init: RequestInit,
  opts: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, void> {
  const {
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    totalTimeoutMs,
    signal: callerSignal,
    mode = "sse",
    parseSse = defaultParseSse,
  } = opts;

  // Fail fast on an already-aborted caller signal: end silently (no events),
  // matching how an aborted stream behaves once it has started.
  if (callerSignal?.aborted) return;

  const controller = new AbortController();
  let stallFired = false;
  let totalFired = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStall = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStall = () => {
    if (!(stallTimeoutMs > 0)) return;
    clearStall();
    stallTimer = setTimeout(() => {
      stallFired = true;
      controller.abort();
    }, stallTimeoutMs);
  };

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (typeof totalTimeoutMs === "number" && totalTimeoutMs > 0) {
    totalTimer = setTimeout(() => {
      totalFired = true;
      controller.abort();
    }, totalTimeoutMs);
  }

  const cleanup = () => {
    clearStall();
    if (totalTimer !== null) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  };

  // Translate an abort/reject into the right terminal event. Caller-driven
  // aborts end the generator silently (return nothing); a timer-driven abort
  // yields a distinct `timeout` event.
  const terminalFromAbort = (cause: unknown): StreamEvent | null => {
    if (totalFired) {
      return {
        type: "timeout",
        error: new StreamTimeoutError("total", totalTimeoutMs ?? 0, cause),
      };
    }
    if (stallFired) {
      return {
        type: "timeout",
        error: new StreamTimeoutError("stall", stallTimeoutMs, cause),
      };
    }
    // Caller-initiated abort (or a pre-aborted caller signal): silent stop.
    if (callerSignal?.aborted || isAbortError(cause)) return null;
    // A genuine connection error (TypeError from fetch) — definitive.
    return { type: "error", error: cause as Error };
  };

  try {
    armStall();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const terminal = terminalFromAbort(err);
      if (terminal) yield terminal;
      return;
    }

    if (!res.ok || !res.body) {
      yield {
        type: "error",
        error: new StreamHttpError(res.status, res.statusText),
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        const terminal = terminalFromAbort(err);
        if (terminal) yield terminal;
        return;
      }
      const { value, done } = chunk;
      if (done) break;
      // A byte arrived → the model is alive; reset the stall watchdog.
      armStall();

      const decoded = decoder.decode(value, { stream: true });
      if (mode === "raw") {
        if (decoded) yield { type: "delta", text: decoded };
        continue;
      }

      // SSE: events are separated by a blank line; parse complete frames only.
      buffer += decoded;
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            yield { type: "done" };
            return;
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(payload);
          } catch {
            // Non-JSON data line: emit the raw payload as a token.
            yield { type: "delta", text: payload };
            continue;
          }
          const mapped = parseSse(parsedJson);
          if (!mapped) continue;
          if (mapped.kind === "error") {
            yield { type: "error", error: new Error(mapped.message) };
            return;
          }
          if (mapped.kind === "delta") {
            yield { type: "delta", text: mapped.text, data: mapped.data };
            continue;
          }
          // done
          yield { type: "done", meta: mapped.meta };
          return;
        }
      }
    }
    // Body ended without an explicit done sentinel — treat as complete.
    yield { type: "done" };
  } finally {
    cleanup();
  }
}

/** A non-OK HTTP status from a streaming endpoint. Carries `status`. */
export class StreamHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText?: string) {
    super(`Stream request failed (${status}${statusText ? ` ${statusText}` : ""})`);
    this.name = "StreamHttpError";
    this.status = status;
  }
}

/**
 * Callback front-end over {@link streamEvents}. Resolves when the stream ends
 * (clean, timeout, error, or caller-abort); never rejects — every outcome is
 * delivered through a handler so call sites need no try/catch around it.
 */
export async function streamSse(
  url: string,
  init: RequestInit,
  handlers: StreamHandlers,
  opts: Omit<StreamOptions, "mode"> = {},
): Promise<void> {
  await consume(url, init, handlers, { ...opts, mode: "sse" });
}

/** Like {@link streamSse} but treats the body as a raw (non-SSE) text stream. */
export async function streamRaw(
  url: string,
  init: RequestInit,
  handlers: StreamHandlers,
  opts: Omit<StreamOptions, "mode"> = {},
): Promise<void> {
  await consume(url, init, handlers, { ...opts, mode: "raw" });
}

async function consume(
  url: string,
  init: RequestInit,
  handlers: StreamHandlers,
  opts: StreamOptions,
): Promise<void> {
  for await (const ev of streamEvents(url, init, opts)) {
    switch (ev.type) {
      case "delta":
        handlers.onDelta?.(ev.text, ev.data);
        break;
      case "done":
        handlers.onDone?.(ev.meta);
        break;
      case "timeout":
        handlers.onTimeout?.(ev.error);
        break;
      case "error":
        handlers.onError?.(ev.error);
        break;
    }
  }
}
