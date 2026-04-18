import type { MakeCodeExecutor } from "makecode-mcp/browser";
import type { ToolDescriptor } from "makecode-mcp/browser";

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface StreamChunk {
  choices: [
    {
      delta: {
        content?: string;
        tool_calls?: Array<{
          index: number;
          id?: string;
          type?: "function";
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason: null | "stop" | "tool_calls" | "length";
    },
  ];
}

export type ChatCompletionFn = (params: {
  messages: OpenAIMessage[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
}) => Promise<AsyncIterable<StreamChunk>> | AsyncIterable<StreamChunk>;

export type ToolLoopEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown; result: string; isError: boolean };

export interface ToolLoopOptions {
  completion: ChatCompletionFn;
  executor: MakeCodeExecutor;
  messages: OpenAIMessage[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
  maxSteps?: number;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function accumulateToolCalls(
  acc: Map<number, PendingToolCall>,
  deltas: NonNullable<StreamChunk["choices"][0]["delta"]["tool_calls"]>,
): void {
  for (const d of deltas) {
    const prev = acc.get(d.index) ?? { id: "", name: "", arguments: "" };
    acc.set(d.index, {
      id: d.id ?? prev.id,
      name: d.function?.name ?? prev.name,
      arguments: prev.arguments + (d.function?.arguments ?? ""),
    });
  }
}

async function dispatchTool(
  executor: MakeCodeExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "start_session": {
      const r = await executor.startSession();
      return JSON.stringify(r);
    }
    case "end_session":
      await executor.endSession(args.session_id as string);
      return JSON.stringify({ ok: true });
    case "get_current_code":
      return await executor.getCurrentCode(args.session_id as string);
    case "set_code":
      await executor.setCode(args.session_id as string, args.code as string);
      return JSON.stringify({ ok: true });
    case "get_blocks_svg":
      return await executor.getBlocksSvg(args.session_id as string);
    case "get_hex_file":
      return await executor.getHexFile(args.session_id as string);
    case "get_blocks_svg_from_code":
      return await executor.getBlocksSvgFromCode(args.code as string);
    case "get_hex_file_from_code":
      return await executor.getHexFileFromCode(args.code as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Replace a missing or placeholder session_id (e.g. "$SESSION_ID") with the
 * last known real one.  The model sometimes batches start_session with a
 * subsequent stateful call before it can know the returned id, or it emits a
 * literal placeholder string instead of the actual UUID. */
function injectSessionId(
  args: Record<string, unknown>,
  knownSessionId: string | undefined,
): Record<string, unknown> {
  if (!knownSessionId) return args;
  const sid = args.session_id;
  if (!sid || typeof sid !== "string" || sid.startsWith("$")) {
    return { ...args, session_id: knownSessionId };
  }
  return args;
}

export async function* runToolLoop(opts: ToolLoopOptions): AsyncIterable<ToolLoopEvent> {
  const { completion, executor, tools, signal } = opts;
  const maxSteps = opts.maxSteps ?? 10;
  const history: OpenAIMessage[] = [...opts.messages];
  // Tracks the most recently acquired session_id so it can be injected into
  // calls that arrive without one (model batching) or with a placeholder.
  let knownSessionId: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const stream = await completion({ messages: history, tools, signal });
    const pending = new Map<number, PendingToolCall>();
    let assistantText = "";
    let finish: StreamChunk["choices"][0]["finish_reason"] = null;

    for await (const chunk of stream) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const choice = chunk.choices[0];
      if (!choice) continue;
      const { delta } = choice;
      if (delta.content) {
        assistantText += delta.content;
        yield { type: "text-delta", delta: delta.content };
      }
      if (delta.tool_calls) accumulateToolCalls(pending, delta.tool_calls);
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (finish === "tool_calls" && pending.size === 0) {
      // Hermes-style done signal: schema-constrained `[]` output. Follow up
      // once with tools disabled so the model can produce a plain-text reply.
      const followUp = await completion({ messages: history, tools: [], signal });
      for await (const chunk of followUp) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const content = chunk.choices[0]?.delta?.content;
        if (content) yield { type: "text-delta", delta: content };
      }
      return;
    }

    if (finish === "tool_calls" || pending.size > 0) {
      const calls = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => c);
      history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      type DispatchResult = { call: PendingToolCall; args: Record<string, unknown>; result: string; isError: boolean };

      async function dispatchOne(c: PendingToolCall): Promise<DispatchResult> {
        const args = injectSessionId(parseArgs(c.arguments), knownSessionId);
        try {
          const result = await dispatchTool(executor, c.name, args);
          return { call: c, args, result, isError: false };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { call: c, args, result: msg, isError: true };
        }
      }

      let results: DispatchResult[];
      const startIdx = calls.findIndex((c) => c.name === "start_session");
      if (startIdx !== -1) {
        // Run start_session first so we have the session_id before dispatching
        // any co-batched stateful calls.
        const startRes = await dispatchOne(calls[startIdx]);
        if (!startRes.isError) {
          try {
            const parsed = JSON.parse(startRes.result);
            if (typeof parsed.session_id === "string") knownSessionId = parsed.session_id;
          } catch { /* ignore */ }
        }
        const rest = calls.filter((_, i) => i !== startIdx);
        const restResults = await Promise.all(rest.map(dispatchOne));
        // Reassemble in original call order.
        let ri = 0;
        results = calls.map((_, i) => (i === startIdx ? startRes : restResults[ri++]));
      } else {
        results = await Promise.all(calls.map(dispatchOne));
      }

      // Extract session_id from any completed start_session (handles the case
      // where it ran outside a batch too).
      for (const r of results) {
        if (r.call.name === "start_session" && !r.isError) {
          try {
            const parsed = JSON.parse(r.result);
            if (typeof parsed.session_id === "string") knownSessionId = parsed.session_id;
          } catch { /* ignore */ }
        }
      }

      for (const r of results) {
        history.push({ role: "tool", tool_call_id: r.call.id, content: r.result });
        yield {
          type: "tool-call",
          id: r.call.id,
          name: r.call.name,
          args: r.args,
          result: r.result,
          isError: r.isError,
        };
      }
      continue;
    }

    return;
  }

  throw new Error(`Tool loop exceeded max steps (${maxSteps})`);
}
