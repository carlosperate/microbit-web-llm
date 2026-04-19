import type { InitProgressReport } from "@mlc-ai/web-llm";
import type { ChatCompletionFn, OpenAIMessage, StreamChunk } from "./tool-loop.js";
import { createLogger } from "makecode-mcp/browser";

const log = createLogger("webllm");

// Qwen2.5-Coder 7B is the preferred model (coder-tuned). WebLLM's built-in
// function-calling path is hard-coded to Hermes-2-Pro variants, but the
// underlying mechanism — a grammar-constrained JSON-array output plus a
// system-prompt describing the tools — is model-agnostic. Grammar-level
// constraints force any sufficiently capable instruction-tuned model to emit
// valid tool-call JSON, and Qwen2.5-Coder follows the pattern reliably.
export const MODEL_ID = "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC";

// User-selectable models. Qwen is coder-tuned and needs our manual
// Hermes-2-Pro transformation; Hermes-3 is already on WebLLM's
// function-calling allowlist and handles tools natively.
export const MODELS = [
  {
    id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
    shortLabel: "Qwen2.5-Coder 7B",
    label: "Qwen2.5-Coder 7B Instruct (coder-tuned, manual tool transform)",
  },
  {
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    shortLabel: "Hermes-3 8B",
    label: "Hermes-3 Llama 3.1 8B (native tool calling)",
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

function needsManualTransform(modelId: string): boolean {
  // WebLLM auto-applies the Hermes-2-Pro transformation only for
  // `Hermes-2-Pro-*` IDs; Hermes-3 is allowlisted and handles tools natively.
  // Everything else (Qwen) needs the manual injection.
  return !modelId.startsWith("Hermes-");
}

// JSON schema for one Hermes-2-Pro tool call; an array of these is the
// grammar we constrain the model to. Copied verbatim from web-llm's internals
// (officialHermes2FunctionCallSchema) so behaviour matches the supported path.
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

async function* parseHermesStream(
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
  let parsed: Array<{ name: string; arguments: unknown }> = [];
  if (buffer.trim().length > 0) {
    try {
      const raw = JSON.parse(buffer);
      if (Array.isArray(raw)) parsed = raw;
    } catch (err) {
      log.warn("hermes stream: JSON parse failed, treating as empty tool-calls", {
        bufferBytes: buffer.length,
        error: (err as Error).message,
      });
      // Fall through with empty array; tool-loop will issue a follow-up.
    }
  }
  log.info("hermes stream parsed", {
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
  const manualTransform = needsManualTransform(modelId);
  log.info("loadWebLLM: path decided", { manualTransform, nativeToolCalling: !manualTransform });
  if (manualTransform && !webllm.functionCallingModelIds.includes(modelId)) {
    log.info("patching functionCallingModelIds to allow manual-transform model", { modelId });
    webllm.functionCallingModelIds.push(modelId);
  }
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

  return async ({ messages, tools, signal: _signal }) => {
    const hasTools = tools.length > 0;
    log.debug("chat.completions.create", {
      hasTools,
      toolCount: tools.length,
      messageCount: messages.length,
      manualTransform,
    });
    if (!hasTools) {
      const stream = await engine.chat.completions.create({
        messages: messages as any,
        stream: true,
      });
      return stream as unknown as AsyncIterable<StreamChunk>;
    }
    if (!manualTransform) {
      // Native path: let web-llm handle the Hermes-2-Pro/3 tool transformation.
      const stream = await engine.chat.completions.create({
        messages: messages as any,
        tools: tools as any,
        tool_choice: "auto",
        stream: true,
      });
      return stream as unknown as AsyncIterable<StreamChunk>;
    }
    // Hermes-2-Pro-style transformation: inject system prompt describing the
    // tools, constrain output to the function-call JSON-array schema, and do
    // NOT pass `tools` through (we've already encoded them into the prompt
    // and grammar).
    // Preserve any app-level system messages by prepending them before the
    // Hermes tool-calling prompt so the app's guidance still reaches the model.
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
    log.debug("manual hermes transform", {
      systemPromptChars: systemPrompt.length,
      nonSystemMessages: withSystem.length - 1,
    });
    const stream = await engine.chat.completions.create({
      messages: withSystem as any,
      response_format: { type: "json_object", schema: FUNCTION_CALL_SCHEMA_ARRAY } as any,
      stream: true,
    });
    return parseHermesStream(stream as any);
  };
}
