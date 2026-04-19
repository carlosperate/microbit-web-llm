import type { BrowserExecutor } from "makecode-mcp/browser";
import type { ToolDescriptor } from "makecode-mcp/browser";
import { createLogger, preview } from "makecode-mcp/browser";

const log = createLogger("tool-loop");

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

export interface CompletionOptions {
  /** Sampling temperature (0–1.5). Higher = more random. */
  temperature?: number;
  /** Hard cap on response tokens. `null`/`undefined` = no cap. */
  maxTokens?: number | null;
}

export type ChatCompletionFn = (params: {
  messages: OpenAIMessage[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
  options?: CompletionOptions;
}) => Promise<AsyncIterable<StreamChunk>> | AsyncIterable<StreamChunk>;

export type ToolLoopEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown; result: string; isError: boolean };

export interface ToolLoopOptions {
  completion: ChatCompletionFn;
  executor: BrowserExecutor;
  messages: OpenAIMessage[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
  maxSteps?: number;
  completionOptions?: CompletionOptions;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

// Stateful tools (acting on the editor) that count as actually advancing the
// user's request. Used by the stall-retry heuristic: if the model emits []
// before any of these have fired, we nudge it once instead of falling back to
// a tools-disabled plain-text reply.
const SUBSTANTIVE_TOOLS = new Set([
  "set_code",
  "get_current_code",
  "get_blocks_svg",
  "get_hex_file",
  "get_blocks_svg_from_code",
  "get_hex_file_from_code",
]);

// Fires once if the model stalls (emits []) before doing any substantive work.
// Typical failure mode: user asks for a program, model replies in plain text
// describing the tool calls inside a TypeScript code block instead of
// actually calling them.
const STALL_REMINDER =
  "[workflow reminder] If the user asked you to create, write, load, or modify a program for the micro:bit, the task requires tool calls — emit them now. Typical sequence: set_code with the program, then get_blocks_svg to show the blocks. Do NOT describe the tool calls in plain text or inside a TypeScript code block — the student cannot execute them; only your actual tool_calls take effect. Only emit [] if the user's message is purely conversational and no tool action is needed.";

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
  executor: BrowserExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "get_current_code":
      return await executor.getCurrentCode();
    case "set_code":
      await executor.setCode(args.code as string);
      return JSON.stringify({ ok: true });
    case "get_blocks_svg":
      return await executor.getBlocksSvg();
    case "get_hex_file":
      return await executor.getHexFile();
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

function historyHasSubstantiveCall(history: OpenAIMessage[]): boolean {
  return history.some(
    (m) =>
      m.role === "assistant" &&
      m.tool_calls?.some((t) => SUBSTANTIVE_TOOLS.has(t.function.name)),
  );
}

export async function* runToolLoop(opts: ToolLoopOptions): AsyncIterable<ToolLoopEvent> {
  const { completion, executor, tools, signal, completionOptions } = opts;
  const maxSteps = opts.maxSteps ?? 10;
  const history: OpenAIMessage[] = [...opts.messages];
  // Fires at most once per run: when the model stalls (emits []) before doing
  // any substantive work, inject a reminder and retry instead of falling back
  // to a tools-disabled plain-text reply.
  let stallRetried = false;

  log.group(`runToolLoop (maxSteps=${maxSteps}, tools=${tools.length}, history=${history.length})`);
  try {
    for (let step = 0; step < maxSteps; step++) {
      log.info(`step ${step + 1}: requesting completion`, {
        historyLen: history.length,
        lastRole: history[history.length - 1]?.role,
      });
      const endStep = log.time(`step ${step + 1} stream`);
      const stream = await completion({ messages: history, tools, signal, options: completionOptions });
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
      endStep();
      log.info(`step ${step + 1}: stream complete`, {
        finish,
        pendingCalls: pending.size,
        textChars: assistantText.length,
      });

      if (finish === "tool_calls" && pending.size === 0) {
        // Hermes-style schema-constrained `[]` output. Two sub-cases:
        // 1. Stall before substantive work — one-time recovery: append a
        //    system reminder and retry with tools still enabled.
        // 2. Genuine done signal — one plain-text follow-up, then return.
        const stalled = !stallRetried && !historyHasSubstantiveCall(history);
        if (stalled) {
          stallRetried = true;
          log.warn("empty tool_calls before any substantive work → injecting STALL_REMINDER and retrying");
          // Merge into the leading system message rather than pushing a new
          // system mid-history — WebLLM's native tool-calling path rejects
          // non-first system messages (SystemMessageOrderError).
          if (history[0]?.role === "system") {
            history[0] = { role: "system", content: `${history[0].content}\n\n${STALL_REMINDER}` };
          } else {
            history.unshift({ role: "system", content: STALL_REMINDER });
          }
          continue;
        }
        log.info("empty tool_calls after substantive work → follow-up with tools disabled for plain-text reply");
        const followUp = await completion({ messages: history, tools: [], signal, options: completionOptions });
        for await (const chunk of followUp) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield { type: "text-delta", delta: content };
        }
        log.info("plain-text follow-up complete");
        return;
      }

      if (finish === "tool_calls" || pending.size > 0) {
        const calls = [...pending.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => c);
        log.info(
          `dispatching ${calls.length} tool call(s) in parallel: ${calls.map((c) => c.name).join(", ")}`,
        );
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

        const results: DispatchResult[] = await Promise.all(
          calls.map(async (c) => {
            const args = parseArgs(c.arguments);
            log.info(`  → ${c.name}(${preview(args)})`);
            const endCall = log.time(`  ← ${c.name}`);
            try {
              const result = await dispatchTool(executor, c.name, args);
              endCall();
              log.info(`  ← ${c.name} ok`, { resultBytes: result.length, preview: preview(result) });
              return { call: c, args, result, isError: false };
            } catch (err) {
              endCall();
              const msg = err instanceof Error ? err.message : String(err);
              log.warn(`  ← ${c.name} error: ${msg}`);
              return { call: c, args, result: msg, isError: true };
            }
          }),
        );

        for (const r of results) {
          history.push({
            role: "tool",
            tool_call_id: r.call.id,
            content: r.result,
          });
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

      log.info(`step ${step + 1}: finish=${finish}, returning`);
      return;
    }

    log.error(`exceeded maxSteps (${maxSteps}) — aborting loop`);
    throw new Error(`Tool loop exceeded max steps (${maxSteps})`);
  } finally {
    log.groupEnd();
  }
}
