/**
 * True tool-calling agent loop.
 *
 * Wraps the local LLM in a ReAct-style loop:
 *   1. The agent sees a user goal + a system prompt that enumerates the
 *      tools it can call.
 *   2. The model emits either a final ANSWER or a TOOL_CALL.
 *   3. If TOOL_CALL, we run the tool, append the result, loop.
 *   4. Bounded by `maxSteps` to prevent runaways.
 *
 * The protocol is JSON-line based — every model turn must emit a single
 * JSON object on ONE LINE of the form:
 *
 *   { "thought": "…", "action": { "tool": "name", "input": {…} } }
 *
 * or, when done:
 *
 *   { "thought": "…", "answer": "…" }
 *
 * We tolerate fenced code blocks and surrounding prose by extracting the
 * first JSON object found.  Repeated parse failures count toward the step
 * budget and we abort with a "model produced unparseable output" answer.
 *
 * Tools are registered at session-open time, not module-load time.  Each
 * tool is a pure async function (input) → output with a JSON-Schema-style
 * input descriptor used in the system prompt.
 *
 * This module deliberately does NOT depend on react / DOM — it's a pure
 * orchestrator usable from anywhere.
 */

import { generateText } from './localLlm';

export interface AgentTool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>;
  invoke(input: TInput): Promise<TOutput>;
}

export interface AgentTrace {
  step: number;
  thought?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolError?: string;
  rawModelOutput: string;
}

export interface AgentRunResult {
  answer: string;
  trace: AgentTrace[];
  finished: 'answer' | 'max-steps' | 'parse-error' | 'tool-error';
}

export interface AgentRunOptions {
  /** The user-facing goal. */
  goal: string;
  /** Tools the agent may call. */
  tools: AgentTool[];
  /** Hard cap on iterations.  Default 6. */
  maxSteps?: number;
  /** Optional extra context to inject in the system prompt. */
  contextHint?: string;
  /** Override the LLM client (for tests). */
  generate?: (input: { prompt: string; system?: string; temperature?: number; maxTokens?: number }) => Promise<{ text: string }>;
  /** Subscribe to step-by-step traces as they happen. */
  onTrace?: (trace: AgentTrace) => void;
}

function buildSystemPrompt(tools: AgentTool[], contextHint?: string): string {
  const toolDescriptions = tools
    .map((tool) => {
      const inputs = Object.entries(tool.inputSchema)
        .map(([key, spec]) => `    ${key} (${spec.type}${spec.required ? ', required' : ''}): ${spec.description}`)
        .join('\n');
      return `  - ${tool.name}: ${tool.description}\n    Input:\n${inputs}`;
    })
    .join('\n\n');

  return [
    'You are an autonomous agent inside a CFA exam-prep app.  Solve the user goal step by step.',
    'At every turn, emit EXACTLY ONE JSON object on a single line. No prose around it.',
    '',
    'Two valid shapes:',
    '  { "thought": "<short reasoning>", "action": { "tool": "<name>", "input": { … } } }',
    '  { "thought": "<short reasoning>", "answer": "<final answer for the user>" }',
    '',
    'Available tools:',
    toolDescriptions,
    '',
    contextHint ? `Additional context:\n${contextHint}` : '',
    'Rules:',
    ' - Do not invent tools.  Only call tools listed above.',
    ' - Call a tool only when needed.  Return an answer when you have enough information.',
    ' - Keep thoughts under 25 words.',
  ]
    .filter(Boolean)
    .join('\n');
}

const JSON_OBJECT_RE = /\{[\s\S]*\}/;

interface ParsedTurn {
  thought?: string;
  action?: { tool: string; input?: Record<string, unknown> };
  answer?: string;
}

export function parseAgentTurn(raw: string): ParsedTurn | null {
  const match = raw.match(JSON_OBJECT_RE);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as ParsedTurn;
    if (obj.action && typeof obj.action.tool === 'string') {
      return obj;
    }
    if (typeof obj.answer === 'string') {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run a single agent session over the supplied tools.
 *
 * Returns when the model emits an `answer`, hits `maxSteps`, or fails to
 * produce a parseable turn twice in a row.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const tools = opts.tools;
  const maxSteps = opts.maxSteps ?? 6;
  const generate = opts.generate ?? generateText;
  const system = buildSystemPrompt(tools, opts.contextHint);
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const trace: AgentTrace[] = [];
  let consecutiveParseFailures = 0;
  // The running scratchpad — the conversation history fed to each turn.
  const scratch: string[] = [`Goal: ${opts.goal}`];

  for (let step = 1; step <= maxSteps; step++) {
    const prompt = scratch.join('\n\n');
    let raw = '';
    try {
      const out = await generate({ prompt, system, temperature: 0.2, maxTokens: 600 });
      raw = (out.text || '').trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'llm-failed';
      const t: AgentTrace = { step, rawModelOutput: '', toolError: reason };
      trace.push(t);
      opts.onTrace?.(t);
      return { answer: `Agent failed: ${reason}`, trace, finished: 'tool-error' };
    }

    const parsed = parseAgentTurn(raw);
    if (!parsed) {
      consecutiveParseFailures++;
      const t: AgentTrace = { step, rawModelOutput: raw };
      trace.push(t);
      opts.onTrace?.(t);
      if (consecutiveParseFailures >= 2) {
        return { answer: 'Agent produced unparseable output twice in a row.', trace, finished: 'parse-error' };
      }
      scratch.push(`(Previous output was not valid JSON — emit exactly one JSON object next time.)`);
      continue;
    }
    consecutiveParseFailures = 0;

    if (parsed.answer !== undefined) {
      const t: AgentTrace = { step, thought: parsed.thought, rawModelOutput: raw };
      trace.push(t);
      opts.onTrace?.(t);
      return { answer: parsed.answer, trace, finished: 'answer' };
    }

    const action = parsed.action!;
    const tool = toolByName.get(action.tool);
    const t: AgentTrace = {
      step,
      thought: parsed.thought,
      toolName: action.tool,
      toolInput: action.input,
      rawModelOutput: raw,
    };

    if (!tool) {
      t.toolError = `Unknown tool: ${action.tool}`;
      trace.push(t);
      opts.onTrace?.(t);
      scratch.push(`Observation: tool "${action.tool}" does not exist.  Choose from: ${[...toolByName.keys()].join(', ')}.`);
      continue;
    }

    try {
      const output = await tool.invoke((action.input ?? {}) as Record<string, unknown>);
      t.toolOutput = output;
      trace.push(t);
      opts.onTrace?.(t);
      scratch.push(`Action: ${tool.name}(${JSON.stringify(action.input ?? {})})\nObservation: ${JSON.stringify(output)}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'tool-failed';
      t.toolError = reason;
      trace.push(t);
      opts.onTrace?.(t);
      scratch.push(`Action: ${tool.name}(${JSON.stringify(action.input ?? {})})\nObservation: error: ${reason}`);
    }
  }

  return { answer: 'Reached the step limit without a final answer.', trace, finished: 'max-steps' };
}
