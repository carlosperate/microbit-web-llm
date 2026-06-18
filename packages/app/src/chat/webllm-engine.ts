import type {
  AppConfig,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  InitProgressReport,
} from "@mlc-ai/web-llm";
import type { ChatCompletionFn, OpenAIMessage, StreamChunk } from "./tool-loop.js";
import {
  HEX_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  createLogger,
  preview,
  stubHexResult,
  stubImageResult,
} from "makecode-mcp/browser";
import { DEFAULT_MODEL_ID } from "../config.js";

/** WebLLM's accepted message shape — the union of system / user / assistant /
 *  tool variants from the OpenAI-compatible protocol. Our `OpenAIMessage` is a
 *  structural subset, but the WebLLM types are stricter (e.g. assistant.content
 *  is `string | null`, not optional), so we adapt rather than cast at the call
 *  site. */
export type WebLLMMessage = ChatCompletionMessageParam;

/** Adapt our internal {@link OpenAIMessage} history to WebLLM's stricter type.
 *  After `flattenToolHistory` runs, no `role: "tool"` or assistant `tool_calls`
 *  remain, so each message maps to a system/user/assistant text param. */
export function toWebLLMMessages(messages: OpenAIMessage[]): WebLLMMessage[] {
  return messages.map((m): WebLLMMessage => {
    if (m.role === "system") return { role: "system", content: m.content };
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content ?? "" };
    }
    // role: "tool" — should not occur after flattenToolHistory; pass through
    // as a user message so the engine doesn't reject the request entirely.
    return { role: "user", content: m.content };
  });
}

const log = createLogger("webllm");


// JSON schema for one tool call; an array of these is the grammar we constrain
// the model to. Shape matches Hermes-2-Pro's officialHermes2FunctionCallSchema.
const FUNCTION_CALL_SCHEMA_ARRAY = `{"type":"array","items":{"properties":{"arguments":{"title":"Arguments","type":"object"},"name":{"title":"Name","type":"string"}},"required":["arguments","name"],"title":"FunctionCall","type":"object"}}`;

/** The tools-describing system prompt the engine injects on every tools-enabled
 *  completion. Exported so the context meter can measure the same overhead
 *  the model actually receives (~400 tokens of schema text per turn). */
export function buildToolsSystemPrompt(tools: unknown[]): string {
  return (
    `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. ` +
    `You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. ` +
    `IMPORTANT: if the user asks you to write, load, or show a micro:bit program, you MUST call the appropriate tools — never just describe the code or explain how to call the tools. ` +
    `Here are the available tools: <tools> ${JSON.stringify(tools)} </tools>. ` +
    `For each function call return a json object with the form {"name": <function-name>, "arguments": <args-dict>}. ` +
    `Return a JSON array containing every function call you want to make, in order. Return an empty array [] only when you genuinely want to reply in plain text without calling any tool.`
  );
}

export type LoadState =
  | { status: "idle" }
  | { status: "unsupported"; reason: string }
  | { status: "loading"; progress: number; text: string; modelId: string }
  | { status: "ready" }
  | { status: "error"; error: Error };

export function isWebGPUSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

// WebLLM's chat templates reject role:"tool" and assistant tool_calls, and
// require the last message be user/tool. Collapse each assistant{tool_calls}
// + following tool messages into one assistant text message (JSON the model
// emitted + [result <name>] <content> lines). Emitting results as fresh user
// turns made the model treat each result as a new request and loop forever.
export function flattenToolHistory(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const idToName = new Map(m.tool_calls.map((tc) => [tc.id, tc.function.name]));
      const calls = m.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: safeParseArgs(tc.function.arguments),
      }));
      const lines = [JSON.stringify(calls)];
      while (i + 1 < messages.length && messages[i + 1].role === "tool") {
        const t = messages[++i] as Extract<OpenAIMessage, { role: "tool" }>;
        const name = idToName.get(t.tool_call_id) ?? "tool";
        lines.push(`[result ${name}] ${stubLargeResult(name, t.content)}`);
      }
      const content = m.content ? [m.content, ...lines].join("\n") : lines.join("\n");
      out.push({ role: "assistant", content });
      continue;
    }
    out.push(m);
  }
  if (out.length > 0 && out[out.length - 1].role === "assistant") {
    out.push({ role: "user", content: TOOL_CONTINUATION_PROMPT });
  }
  return out;
}

export const TOOL_CONTINUATION_PROMPT = `(Tool results above. The original task is most likely complete now — stop calling tools so you can give the student a short plain-text explanation on the next turn. Only emit another tool call if the original task genuinely is not finished and the next call will clearly advance it. Do not repeat a tool you already called, and do not call any image tool just to look at code.)`;

// Tool results that are large opaque blobs the model cannot use — feeding them
// back through tokenization wastes context and, for hex (~1.7MB base64), blows
// the WebLLM tokenizer stack with "Maximum call stack size exceeded".
function stubLargeResult(name: string, content: string): string {
  if (IMAGE_TOOL_NAMES.has(name)) return stubImageResult(content.length);
  if (HEX_TOOL_NAMES.has(name)) return stubHexResult(content.length);
  return content;
}

function safeParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function* parseToolCallStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<StreamChunk> {
  // The engine streams content deltas holding the JSON array. Suppress them
  // from the caller and emit one synthetic chunk at end with tool_calls parsed.
  let buffer = "";
  let finish: StreamChunk["choices"][0]["finish_reason"] = null;
  let usage: StreamChunk["usage"] | undefined;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage; // last chunk under include_usage:true
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) buffer += choice.delta.content;
    // Collapse WebLLM's "abort" into tool_calls so the loop treats it as non-terminal.
    if (choice.finish_reason) {
      finish = choice.finish_reason === "abort" ? "tool_calls" : choice.finish_reason;
    }
  }
  log.debug("raw model output", {
    finish,
    bytes: buffer.length,
    sample: preview(buffer),
  });
  let parsed: Array<{ name: string; arguments: unknown }> = [];
  if (buffer.trim().length > 0) {
    try {
      const raw = JSON.parse(buffer);
      if (Array.isArray(raw)) parsed = raw;
    } catch (err) {
      log.warn("tool-call stream: JSON parse failed, treating as empty tool-calls", {
        bufferBytes: buffer.length,
        error: (err as Error).message,
      });
      // Fall through with empty array; tool-loop will issue a follow-up.
    }
  }
  log.info("tool-call stream parsed", {
    finish,
    bufferBytes: buffer.length,
    toolCalls: parsed.length,
    names: parsed.map((c) => c.name),
  });
  const tool_calls = parsed.map((c, i) => ({
    index: i,
    id: `call-${Date.now()}-${i}`,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
  yield {
    choices: [
      {
        delta: tool_calls.length > 0 ? { tool_calls } : {},
        finish_reason: finish === "stop" || finish === "length" ? "tool_calls" : (finish ?? "tool_calls"),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** Thrown by {@link loadWebLLM} when {@link LoadHandle.cancel} is invoked
 *  before the engine finishes initialising. Callers should treat this as a
 *  silent abort, not an error to display. */
export class LoadCancelledError extends Error {
  constructor() {
    super("Model load cancelled by user.");
    this.name = "LoadCancelledError";
  }
}

/** Context-window size the engine runs `modelId` with, from
 *  `prebuiltAppConfig…overrides.context_window_size`. `null` if the record
 *  lacks the override (older builds) — the UI hides the meter then. */
export function resolveContextWindow(appConfig: AppConfig, modelId: string): number | null {
  return (
    appConfig.model_list.find((m) => m.model_id === modelId)?.overrides?.context_window_size ?? null
  );
}

/** What a successful {@link loadWebLLM} resolves with. `contextWindow` is
 *  {@link resolveContextWindow} for the loaded model — the value the engine is
 *  actually running with. May be `null` for older model records (see there). */
export type LoadedModel = {
  completion: ChatCompletionFn;
  contextWindow: number | null;
};

/** Handle returned by {@link loadWebLLM} so the caller can cancel an
 *  in-flight load. `cancel()` aborts the model fetch via `engine.unload()` and
 *  causes `promise` to reject with {@link LoadCancelledError}. */
export type LoadHandle = {
  promise: Promise<LoadedModel>;
  cancel: () => void;
};

export function loadWebLLM(
  onProgress: (r: InitProgressReport) => void,
  modelId: string = DEFAULT_MODEL_ID,
): LoadHandle {
  let cancelFn: () => void = () => {
    // No-op until the engine is constructed; the `cancelled` flag below makes
    // the promise reject anyway so early cancels are honoured.
  };
  let cancelled = false;
  const promise = (async (): Promise<LoadedModel> => {
    if (!isWebGPUSupported()) {
      log.error("WebGPU unavailable — refusing to load model");
      throw new Error("WebGPU is not available in this browser. Chrome 113+ is required.");
    }
    log.info("loadWebLLM: importing @mlc-ai/web-llm", { modelId });
    const webllm = await import("@mlc-ai/web-llm");
    if (cancelled) throw new LoadCancelledError();
    // Split `new MLCEngine` from `reload(modelId)` (vs CreateMLCEngine) so we
    // hold the engine reference *before* reload begins — engine.unload() then
    // aborts reload's network/cache fetches, which is how we cancel.
    const engine = new webllm.MLCEngine({
      initProgressCallback: (r) => {
        // Throwing here is the ONLY way to stop a cache-load mid-flight.
        // engine.unload() aborts WebLLM's reloadController, but the cache-load
        // loop in fetchTensorCacheInternal doesn't consult it (no signal on
        // artifactCache.fetchWithCache). Without this throw, a cancel during
        // cache load still uploads every shard to the GPU. Gated on
        // `cancelled` so normal loads are unaffected.
        if (cancelled) throw new LoadCancelledError();
        if (r.progress === 0 || r.progress === 1 || Math.round((r.progress ?? 0) * 100) % 20 === 0) {
          log.info("load progress", { progress: r.progress, text: r.text });
        }
        onProgress(r);
      },
    });
    // Also fire engine.unload() — that aborts the AbortController used by
    // the *download-phase* fetches (fast path when cancel happens before the
    // cache is populated). The throw above handles the cache-load path.
    cancelFn = () => {
      log.info("loadWebLLM: cancel requested → engine.unload()");
      engine.unload().catch((err) => log.warn("engine.unload() during cancel rejected", err));
    };
    const endLoad = log.time("MLCEngine.reload (first run downloads weights)");
    try {
      await engine.reload(modelId);
    } catch (err) {
      if (cancelled) throw new LoadCancelledError();
      throw err;
    } finally {
      endLoad();
    }
    if (cancelled) {
      // Reload returned successfully despite cancel (possible if cancel
      // landed between the final progress tick and the resolve). Fully
      // unload now so the just-loaded pipeline + GPU buffers don't linger.
      log.info("loadWebLLM: reload completed after cancel → unloading engine");
      engine.unload().catch((err) => log.warn("post-cancel unload rejected", err));
      throw new LoadCancelledError();
    }
    const contextWindow = resolveContextWindow(webllm.prebuiltAppConfig, modelId);
    log.info("engine ready", { modelId, contextWindow });

    const completion: ChatCompletionFn = async ({ messages, tools, signal: _signal, options }) => {
    const hasTools = tools.length > 0;
    const samplingOpts: Record<string, unknown> = {};
    if (typeof options?.temperature === "number") samplingOpts.temperature = options.temperature;
    if (typeof options?.maxTokens === "number" && options.maxTokens > 0) samplingOpts.max_tokens = options.maxTokens;
    log.debug("chat.completions.create", {
      hasTools,
      toolCount: tools.length,
      messageCount: messages.length,
      sampling: samplingOpts,
    });
    if (!hasTools) {
      // Same flatten as the tools path: WebLLM rejects role: "tool" and
      // assistant tool_calls regardless of whether tools are passed in.
      const system = messages.filter((m) => m.role === "system");
      const rest = flattenToolHistory(messages.filter((m) => m.role !== "system"));
      const stream = await engine.chat.completions.create({
        messages: toWebLLMMessages([...system, ...rest]),
        stream: true,
        stream_options: { include_usage: true },
        ...samplingOpts,
      });
      return stream as unknown as AsyncIterable<StreamChunk>;
    }
    // Inject the tools-describing system prompt and grammar-constrain output
    // to a JSON array of `{name, arguments}`. We do NOT pass `tools` through —
    // the schema already encodes them. Prepend app-level system messages so
    // their guidance still reaches the model.
    const toolsPrompt = buildToolsSystemPrompt(tools);
    const appSystem = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemPrompt = appSystem ? `${appSystem}\n\n${toolsPrompt}` : toolsPrompt;
    const withSystem: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...flattenToolHistory(messages.filter((m) => m.role !== "system")),
    ];
    log.debug("tool-call transform", {
      systemPromptChars: systemPrompt.length,
      nonSystemMessages: withSystem.length - 1,
    });
    const stream = await engine.chat.completions.create({
      messages: toWebLLMMessages(withSystem),
      response_format: { type: "json_object", schema: FUNCTION_CALL_SCHEMA_ARRAY },
      stream: true,
      stream_options: { include_usage: true },
      ...samplingOpts,
    });
      return parseToolCallStream(stream);
    };
    return { completion, contextWindow };
  })();
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelFn();
    },
  };
}
