import type { BrowserExecutor, BrowserToolName, ToolDescriptor } from "makecode-mcp/browser";
import { TOOL, createLogger, encodeBlocksImage, encodeHex, preview } from "makecode-mcp/browser";

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

// Constrained decoding emits each tool call as one synthetic delta with full
// id + arguments — no per-call streaming, so we just collect as-is. If a
// future model uses native streamed deltas (partial args per chunk, keyed by
// index), restore an index-keyed accumulator.
function collectToolCalls(
  out: PendingToolCall[],
  deltas: NonNullable<StreamChunk["choices"][0]["delta"]["tool_calls"]>,
): void {
  for (const d of deltas) {
    out.push({
      id: d.id ?? "",
      name: d.function?.name ?? "",
      arguments: d.function?.arguments ?? "",
    });
  }
}

// Tools that count as advancing the user's request. The stall-retry heuristic
// nudges the model once if it emits [] before any of these fire.
const SUBSTANTIVE_TOOLS: ReadonlySet<string> = new Set<BrowserToolName>([
  TOOL.SESSION_SET_CODE,
  TOOL.SESSION_GET_CODE,
  TOOL.SESSION_GET_BLOCKS_IMG,
  TOOL.SESSION_GET_HEX_FILE,
  TOOL.GET_BLOCKS_IMG_FROM_CODE,
]);

// Injected once if the model stalls (emits []) before any substantive call —
// typical failure mode is describing the calls inside a TS code block.
const STALL_REMINDER = `[workflow reminder] If the user asked you to create, write, load, or modify a program for the micro:bit, the task requires tool calls — emit them now. Typical sequence: ${TOOL.SESSION_SET_CODE} with the program, then ${TOOL.SESSION_GET_BLOCKS_IMG} to show the blocks. Do NOT describe the tool calls in plain text or inside a TypeScript code block — the student cannot execute them; only your actual tool_calls take effect. Only emit [] if the user's message is purely conversational and no tool action is needed.`;

async function dispatchTool(
  executor: BrowserExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name as BrowserToolName) {
    case TOOL.SESSION_GET_CODE:
      return await executor.getCurrentCode();
    case TOOL.SESSION_SET_CODE:
      await executor.setCode(args.code as string);
      return JSON.stringify({ ok: true });
    case TOOL.SESSION_GET_BLOCKS_IMG:
      return encodeBlocksImage((await executor.getBlocksImage()).pngBase64);
    case TOOL.SESSION_GET_HEX_FILE:
      return encodeHex(await executor.getHexFile());
    case TOOL.GET_BLOCKS_IMG_FROM_CODE:
      return encodeBlocksImage(
        (await executor.getBlocksImageFromCode(args.code as string)).pngBase64,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

type ParsedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

function parseArgs(raw: string): ParsedArgs {
  if (!raw) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `Expected a JSON object for arguments, got ${typeof parsed}.` };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
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

  // Tools-disabled completion, streaming text deltas. Used on every loop
  // exit (done-signal, stall fallback, repeat-call short-circuit).
  async function* plainTextFollowUp(label: string): AsyncIterable<ToolLoopEvent> {
    const followUp = await completion({ messages: history, tools: [], signal, options: completionOptions });
    let text = "";
    for await (const chunk of followUp) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        text += content;
        yield { type: "text-delta", delta: content };
      }
    }
    log.info(`plain-text follow-up complete (${label})`, { chars: text.length, preview: preview(text) });
  }
  // Set once if the model stalls (emits []) before any substantive call;
  // gates the one-shot STALL_REMINDER retry below.
  let stallRetried = false;

  // Track every dispatched (name + args). Smaller models sometimes ignore the
  // "never call the same tool twice" rule and lock into a single-tool loop
  // (e.g. session_get_code every step) — this deterministic guard cuts it short.
  const seenCalls = new Set<string>();
  const callKey = (c: PendingToolCall) => `${c.name}:${c.arguments || "{}"}`;

  log.group(`runToolLoop (maxSteps=${maxSteps}, tools=${tools.length}, history=${history.length})`);
  try {
    for (let step = 0; step < maxSteps; step++) {
      log.info(`step ${step + 1}: requesting completion`, {
        historyLen: history.length,
        lastRole: history[history.length - 1]?.role,
      });
      const endStep = log.time(`step ${step + 1} stream`);
      const stream = await completion({ messages: history, tools, signal, options: completionOptions });
      const pending: PendingToolCall[] = [];
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
        if (delta.tool_calls) collectToolCalls(pending, delta.tool_calls);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      endStep();
      log.info(`step ${step + 1}: stream complete`, {
        finish,
        pendingCalls: pending.length,
        textChars: assistantText.length,
        ...(assistantText.length > 0 ? { textPreview: preview(assistantText) } : {}),
      });

      if (finish === "tool_calls" && pending.length === 0) {
        // Schema-constrained `[]` output. Two sub-cases:
        // 1. Stall before substantive work — one-time recovery: append a
        //    system reminder and retry with tools still enabled.
        // 2. Genuine done signal — one plain-text follow-up, then return.
        const stalled = !stallRetried && !historyHasSubstantiveCall(history);
        if (stalled) {
          stallRetried = true;
          log.warn("empty tool_calls before any substantive work → injecting STALL_REMINDER and retrying");
          // Merge into the leading system message; WebLLM's native path
          // rejects non-first system messages (SystemMessageOrderError).
          if (history[0]?.role === "system") {
            history[0] = { role: "system", content: `${history[0].content}\n\n${STALL_REMINDER}` };
          } else {
            history.unshift({ role: "system", content: STALL_REMINDER });
          }
          continue;
        }
        log.info("empty tool_calls after substantive work → follow-up with tools disabled for plain-text reply");
        yield* plainTextFollowUp("done-signal");
        return;
      }

      if (finish === "tool_calls" || pending.length > 0) {
        const calls = pending;
        // Every call is a repeat — model is stuck. Drop into plain-text
        // follow-up instead of hammering the same tool until maxSteps trips.
        if (calls.every((c) => seenCalls.has(callKey(c)))) {
          log.warn(
            `step ${step + 1}: every requested call is a repeat (${calls.map((c) => c.name).join(", ")}) → forcing plain-text follow-up`,
          );
          yield* plainTextFollowUp("repeat-call recovery");
          return;
        }
        for (const c of calls) seenCalls.add(callKey(c));
        log.info(
          `dispatching ${calls.length} tool call(s) sequentially: ${calls.map((c) => c.name).join(", ")}`,
        );
        history.push({
          role: "assistant",
          content: assistantText,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        type DispatchResult = { call: PendingToolCall; args: unknown; result: string; isError: boolean };

        // Sequential, in emission order. Models batch session_set_code +
        // session_get_blocks_img intending strict ordering; parallel races —
        // a fast read finishes before the slow setCode commits and the editor
        // still looks empty.
        const results: DispatchResult[] = [];
        for (const c of calls) {
          const parsed = parseArgs(c.arguments);
          if (!parsed.ok) {
            // Surface as a tool error so the model can re-emit valid args
            // next turn, instead of coercing to {} and exploding downstream.
            const msg = `Invalid JSON arguments for ${c.name}: ${parsed.error}. Re-emit the call with a valid JSON object.`;
            log.warn(`  ✗ ${c.name} arg parse failed: ${parsed.error}`, { raw: preview(c.arguments) });
            results.push({ call: c, args: c.arguments, result: msg, isError: true });
            continue;
          }
          const args = parsed.args;
          log.info(`  → ${c.name}(${preview(args)})`);
          const endCall = log.time(`  ← ${c.name}`);
          try {
            const result = await dispatchTool(executor, c.name, args);
            endCall();
            log.info(`  ← ${c.name} ok`, { resultBytes: result.length, preview: preview(result, 512) });
            results.push({ call: c, args, result, isError: false });
          } catch (err) {
            endCall();
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`  ← ${c.name} error: ${msg}`);
            results.push({ call: c, args, result: msg, isError: true });
          }
        }

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
