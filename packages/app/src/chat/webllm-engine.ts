import type { InitProgressReport } from "@mlc-ai/web-llm";
import type { ChatCompletionFn, OpenAIMessage, StreamChunk } from "./tool-loop.js";

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
    `When a function call returns a value (e.g. session_id from start_session), store it and pass it as an argument to subsequent calls that require it. ` +
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
    } catch {
      // Fall through with empty array; tool-loop will issue a follow-up.
    }
  }
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
    throw new Error("WebGPU is not available in this browser. Chrome 113+ is required.");
  }
  const webllm = await import("@mlc-ai/web-llm");
  const manualTransform = needsManualTransform(modelId);
  // WebLLM's validator rejects `tools` for any model not in this allowlist.
  // The list is a mutable export; if we're about to apply the transform
  // ourselves, push the id in so validation passes. We don't pass `tools`
  // through for these models, so web-llm's own transformation won't fire.
  if (manualTransform && !webllm.functionCallingModelIds.includes(modelId)) {
    webllm.functionCallingModelIds.push(modelId);
  }
  const engine = await webllm.CreateMLCEngine(modelId, { initProgressCallback: onProgress });
  return async ({ messages, tools, signal: _signal }) => {
    const hasTools = tools.length > 0;
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
    // Hermes tool-calling prompt so the model retains session-lifecycle context.
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
    const stream = await engine.chat.completions.create({
      messages: withSystem as any,
      response_format: { type: "json_object", schema: FUNCTION_CALL_SCHEMA_ARRAY } as any,
      stream: true,
    });
    return parseHermesStream(stream as any);
  };
}
