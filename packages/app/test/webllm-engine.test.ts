import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  flattenToolHistory,
  parseToolCallStream,
  resolveContextWindow,
  toWebLLMMessages,
  TOOL_CONTINUATION_PROMPT,
  loadWebLLM,
} from "../src/chat/webllm-engine.js";
import type { AppConfig, ChatCompletionChunk } from "@mlc-ai/web-llm";

// Hoisted mocks so vi.mock factory can reference them (Vitest hoists vi.mock calls
// to the top of the file, before imports, so the factory closure must use hoisted refs).
const { mockUnload, MockMLCEngine } = vi.hoisted(() => {
  const mockUnload = vi.fn().mockResolvedValue(undefined);
  const MockMLCEngine = vi.fn().mockImplementation(
    ({ initProgressCallback: _cb }: { initProgressCallback: (r: unknown) => void }) => ({
      reload: vi.fn().mockResolvedValue(undefined),
      unload: mockUnload,
      chat: { completions: { create: vi.fn() } },
    }),
  );
  return { mockUnload, MockMLCEngine };
});

vi.mock("@mlc-ai/web-llm", () => ({
  MLCEngine: MockMLCEngine,
  prebuiltAppConfig: { model_list: [] as Array<{ model_id: string; overrides?: { context_window_size?: number } }> },
}));
import type { OpenAIMessage } from "../src/chat/tool-loop.js";
import {
  encodeBlocksImage,
  decodeBlocksImage,
  encodeHex,
  decodeHex,
  stubHexResult,
  stubImageResult,
  TOOL,
} from "makecode-mcp/browser";

describe("resolveContextWindow", () => {
  const appConfig = {
    model_list: [
      { model_id: "with-override", overrides: { context_window_size: 4096 } },
      { model_id: "no-override" },
      { model_id: "empty-overrides", overrides: {} },
    ],
  } as unknown as AppConfig;

  it("returns the model's context_window_size override", () => {
    expect(resolveContextWindow(appConfig, "with-override")).toBe(4096);
  });

  it("returns null when the model record lacks the override (older builds)", () => {
    expect(resolveContextWindow(appConfig, "no-override")).toBeNull();
    expect(resolveContextWindow(appConfig, "empty-overrides")).toBeNull();
  });

  it("returns null for an unknown model id", () => {
    expect(resolveContextWindow(appConfig, "does-not-exist")).toBeNull();
  });
});

describe("flattenToolHistory", () => {
  it("collapses assistant{tool_calls} + following tool messages into one assistant turn", () => {
    const history: OpenAIMessage[] = [
      { role: "user", content: "show me blocks" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: TOOL.SESSION_GET_CODE, arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "let x = 0" },
    ];
    const out = flattenToolHistory(history);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "show me blocks" });
    const collapsed = out[1] as { role: "assistant"; content: string };
    expect(collapsed.role).toBe("assistant");
    expect(collapsed.content).toContain(TOOL.SESSION_GET_CODE);
    expect(collapsed.content).toContain("[result session_get_code] let x = 0");
    expect(out[2]).toEqual({ role: "user", content: TOOL_CONTINUATION_PROMPT });
  });

  it("appends TOOL_CONTINUATION_PROMPT when the last collapsed message is assistant", () => {
    const history: OpenAIMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const out = flattenToolHistory(history);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", content: TOOL_CONTINUATION_PROMPT });
  });

  it("does not append continuation when last message is already user", () => {
    const history: OpenAIMessage[] = [
      { role: "assistant", content: "result" },
      { role: "user", content: "follow-up" },
    ];
    const out = flattenToolHistory(history);
    expect(out).toHaveLength(2);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "follow-up" });
  });

  it("stubs blocks-image tool results instead of dumping bytes", () => {
    const fakePng = "A".repeat(20_000);
    const result = encodeBlocksImage(fakePng);
    const history: OpenAIMessage[] = [
      { role: "user", content: "render" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: TOOL.SESSION_GET_BLOCKS_IMG, arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: result },
    ];
    const out = flattenToolHistory(history);
    const collapsed = out[1] as { role: "assistant"; content: string };
    expect(collapsed.content).not.toContain(fakePng);
    expect(collapsed.content).toContain("not shown");
    expect(collapsed.content).toContain(String(result.length));
  });
});

describe("toWebLLMMessages", () => {
  it("passes system/user/assistant text through unchanged", () => {
    const out = toWebLLMMessages([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
    ]);
  });

  it("normalises assistant content: null to empty string", () => {
    const out = toWebLLMMessages([{ role: "assistant", content: null }]);
    expect(out[0]).toEqual({ role: "assistant", content: "" });
  });
});

describe("TOOL_CONTINUATION_PROMPT", () => {
  // Pinning the prompt text — the engine relies on the exact wording. Update
  // this snapshot deliberately if you change the prompt.
  it("matches the documented contract", () => {
    expect(TOOL_CONTINUATION_PROMPT).toMatchInlineSnapshot(
      `"(Tool results above. The original task is most likely complete now — stop calling tools so you can give the student a short plain-text explanation on the next turn. Only emit another tool call if the original task genuinely is not finished and the next call will clearly advance it. Do not repeat a tool you already called, and do not call any image tool just to look at code.)"`,
    );
  });

  it("does not mention `[]` (which biased Qwen toward empty arrays)", () => {
    expect(TOOL_CONTINUATION_PROMPT).not.toMatch(/\[\s*\]/);
  });
});

describe("tool-result codec round-trips (re-exported through browser entry)", () => {
  it("blocks image", () => {
    const png = "PNGDATA";
    expect(decodeBlocksImage(encodeBlocksImage(png))).toBe(png);
  });
  it("hex file", () => {
    const hex = "HEXDATA";
    expect(decodeHex(encodeHex(hex))).toBe(hex);
  });
  it("stubs include byte length", () => {
    expect(stubImageResult(42)).toContain("42");
    expect(stubHexResult(99)).toContain("99");
  });
});

describe("loadWebLLM LoadHandle", () => {
  let originalNavigator: typeof globalThis.navigator;

  beforeEach(() => {
    mockUnload.mockClear();
    MockMLCEngine.mockClear();
    // Expose navigator.gpu so isWebGPUSupported() returns true in Node test env.
    originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: {} },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("cancel() after a successful load calls engine.unload() exactly once", async () => {
    const handle = loadWebLLM(vi.fn(), "test-model-id");
    await handle.promise; // wait for successful load

    handle.cancel();

    expect(mockUnload).toHaveBeenCalledTimes(1);
  });

  // The slot UI hides the context meter when this comes back null, so we need
  // both branches: model record present (number) and absent (null).
  it("resolves context window from prebuiltAppConfig.model_list overrides", async () => {
    const webllm = await import("@mlc-ai/web-llm") as unknown as {
      prebuiltAppConfig: { model_list: Array<{ model_id: string; overrides?: { context_window_size?: number } }> };
    };
    webllm.prebuiltAppConfig.model_list = [
      { model_id: "test-model-id", overrides: { context_window_size: 4096 } },
    ];

    const handle = loadWebLLM(vi.fn(), "test-model-id");
    const loaded = await handle.promise;

    expect(loaded.contextWindow).toBe(4096);
    expect(typeof loaded.completion).toBe("function");
  });

  it("returns null contextWindow when the model record is missing", async () => {
    const webllm = await import("@mlc-ai/web-llm") as unknown as {
      prebuiltAppConfig: { model_list: Array<{ model_id: string; overrides?: { context_window_size?: number } }> };
    };
    webllm.prebuiltAppConfig.model_list = [];

    const handle = loadWebLLM(vi.fn(), "unknown-model");
    const loaded = await handle.promise;

    expect(loaded.contextWindow).toBeNull();
  });
});

// These exercise the JSON-decode path that the e2e test bypasses (the e2e
// mock returns synthetic post-parse shapes directly). Without this coverage,
// a regression in buffer accumulation, JSON.parse handling, or the fallback
// for non-JSON model emissions would slip through.
describe("parseToolCallStream", () => {
  async function* asStream(chunks: Partial<ChatCompletionChunk>[]): AsyncIterable<ChatCompletionChunk> {
    for (const c of chunks) yield c as ChatCompletionChunk;
  }
  const contentChunk = (content: string): Partial<ChatCompletionChunk> => ({
    choices: [{ delta: { content }, finish_reason: null } as any],
  });
  const finishChunk = (reason: "stop" | "length"): Partial<ChatCompletionChunk> => ({
    choices: [{ delta: {}, finish_reason: reason } as any],
  });

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const c of stream) out.push(c);
    return out;
  }

  it("parses grammar-constrained JSON streamed across multiple deltas into tool_calls", async () => {
    const out = await collect(parseToolCallStream(asStream([
      contentChunk('[{"arguments":'),
      contentChunk('{"code":"basic.showString(\\"hi\\")"},'),
      contentChunk('"name":"session_set_code"}]'),
      finishChunk("stop"),
    ])));
    expect(out).toHaveLength(1);
    const calls = (out[0] as any).choices[0].delta.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("session_set_code");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ code: 'basic.showString("hi")' });
  });

  it("falls through to empty tool_calls when the model emits non-JSON prose (Qwen stall)", async () => {
    // Documented Qwen behaviour: sometimes the model describes the tool
    // workflow as plain text. The synthetic chunk must carry no tool_calls
    // so the tool-loop hits its stall-recovery branch.
    const out = await collect(parseToolCallStream(asStream([
      contentChunk("I will call session_set_code with this program..."),
      finishChunk("stop"),
    ])));
    expect(out).toHaveLength(1);
    const delta = (out[0] as any).choices[0].delta;
    expect(delta.tool_calls).toBeUndefined();
  });

  it("treats an empty `[]` emission as no tool calls", async () => {
    const out = await collect(parseToolCallStream(asStream([
      contentChunk("[]"),
      finishChunk("stop"),
    ])));
    const delta = (out[0] as any).choices[0].delta;
    expect(delta.tool_calls).toBeUndefined();
  });

  it("forwards `usage` from the trailing include_usage chunk on the synthetic chunk", async () => {
    const out = await collect(parseToolCallStream(asStream([
      contentChunk("[]"),
      finishChunk("stop"),
      { choices: [] as any, usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 } as any },
    ])));
    expect((out[0] as any).usage).toEqual({ prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 });
  });
});
