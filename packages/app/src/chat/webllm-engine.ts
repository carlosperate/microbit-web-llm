import type { InitProgressReport } from "@mlc-ai/web-llm";
import type { ChatCompletionFn, OpenAIMessage, StreamChunk } from "./tool-loop.js";
import { createLogger, preview } from "makecode-mcp/browser";

const log = createLogger("webllm");

// All supported models go through the same grammar-constrained tool-calling
// path: a system prompt describing the tools plus `response_format` forcing a
// JSON-array of `{name, arguments}` objects. WebLLM's built-in Hermes-2-Pro
// path is deliberately bypassed — its injected prompt omits the
// `<tool_call></tool_call>` wrapper instruction Hermes-3 was trained on, so
// Hermes-3 emits bare JSON or markdown that WebLLM's parser then rejects.
// Owning the prompt and parser end-to-end gives reliable behaviour across
// every model in the picker and any future additions.
export const MODEL_ID = "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC";

export const MODELS = [
  {
    id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
    shortLabel: "Qwen2.5-Coder 7B",
    label: "Qwen2.5-Coder 7B Instruct (coder-tuned)",
  },
  {
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    shortLabel: "Hermes-3 8B",
    label: "Hermes-3 Llama 3.1 8B",
  },
  {
    id: "Qwen3-8B-q4f16_1-MLC",
    shortLabel: "Qwen3 8B",
    label: "Qwen3 8B",
  },
  {
    id: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
    shortLabel: "Llama-3.1 8B",
    label: "Llama-3.1 8B Instruct",
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

// JSON schema for one tool call; an array of these is the grammar we constrain
// the model to. Shape matches Hermes-2-Pro's officialHermes2FunctionCallSchema.
const FUNCTION_CALL_SCHEMA_ARRAY = `{"type":"array","items":{"properties":{"arguments":{"title":"Arguments","type":"object"},"name":{"title":"Name","type":"string"}},"required":["arguments","name"],"title":"FunctionCall","type":"object"}}`;

function buildToolsSystemPrompt(tools: unknown[]): string {
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

async function* parseToolCallStream(
  stream: AsyncIterable<any>,
): AsyncIterable<StreamChunk> {
  // The engine streams content deltas holding the JSON array. Suppress them
  // from the caller and emit one synthetic chunk at end with tool_calls parsed.
  let buffer = "";
  let finish: StreamChunk["choices"][0]["finish_reason"] = null;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) buffer += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
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
  };
}

export async function loadWebLLM(
  onProgress: (r: InitProgressReport) => void,
  modelId: string = MODEL_ID,
): Promise<ChatCompletionFn> {
  if (!isWebGPUSupported()) {
    log.error("WebGPU unavailable — refusing to load model");
    throw new Error("WebGPU is not available in this browser. Chrome 113+ is required.");
  }
  log.info("loadWebLLM: importing @mlc-ai/web-llm", { modelId });
  const webllm = await import("@mlc-ai/web-llm");
  const endLoad = log.time("CreateMLCEngine (first run downloads weights)");
  const engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (r) => {
      // Keep this quiet — progress fires frequently. Log major waypoints only.
      if (r.progress === 0 || r.progress === 1 || Math.round((r.progress ?? 0) * 100) % 20 === 0) {
        log.info("load progress", { progress: r.progress, text: r.text });
      }
      onProgress(r);
    },
  });
  endLoad();
  log.info("engine ready", { modelId });

  return async ({ messages, tools, signal: _signal, options }) => {
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
      const stream = await engine.chat.completions.create({
        messages: messages as any,
        stream: true,
        ...samplingOpts,
      });
      return stream as unknown as AsyncIterable<StreamChunk>;
    }
    // Inject the tools-describing system prompt and grammar-constrain the
    // output to a JSON array of `{name, arguments}` objects. We do NOT pass
    // `tools` through — the schema has already encoded them.
    // Preserve any app-level system messages by prepending them so the app's
    // guidance still reaches the model.
    const toolsPrompt = buildToolsSystemPrompt(tools);
    const appSystem = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemPrompt = appSystem ? `${appSystem}\n\n${toolsPrompt}` : toolsPrompt;
    const withSystem: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages.filter((m) => m.role !== "system"),
    ];
    log.debug("tool-call transform", {
      systemPromptChars: systemPrompt.length,
      nonSystemMessages: withSystem.length - 1,
    });
    const stream = await engine.chat.completions.create({
      messages: withSystem as any,
      response_format: { type: "json_object", schema: FUNCTION_CALL_SCHEMA_ARRAY } as any,
      stream: true,
      ...samplingOpts,
    });
    return parseToolCallStream(stream as any);
  };
}
