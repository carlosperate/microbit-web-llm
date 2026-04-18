import { describe, it, expect, vi } from "vitest";
import { runToolLoop } from "../src/chat/tool-loop.js";
import type { ChatCompletionFn, StreamChunk } from "../src/chat/tool-loop.js";
import type { MakeCodeExecutor } from "makecode-mcp/browser";

function makeExecutor(overrides: Partial<MakeCodeExecutor> = {}): MakeCodeExecutor {
  return {
    startSession: vi.fn(async () => ({ session_id: "sid-1" })),
    endSession: vi.fn(async () => {}),
    getCurrentCode: vi.fn(async () => ""),
    setCode: vi.fn(async () => {}),
    getBlocksSvg: vi.fn(async () => "<svg></svg>"),
    getHexFile: vi.fn(async () => "aGV4"),
    getBlocksSvgFromCode: vi.fn(async () => "<svg/>"),
    getHexFileFromCode: vi.fn(async () => "aGV4"),
    ...overrides,
  };
}

function chunk(delta: Partial<StreamChunk["choices"][0]["delta"]>, finish_reason: StreamChunk["choices"][0]["finish_reason"] = null): StreamChunk {
  return { choices: [{ delta, finish_reason }] };
}

async function* asStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const c of chunks) yield c;
}

describe("runToolLoop", () => {
  it("streams text deltas when the model responds with plain text", async () => {
    const engine: ChatCompletionFn = async () =>
      asStream([
        chunk({ content: "Hello" }),
        chunk({ content: ", world" }),
        chunk({}, "stop"),
      ]);
    const events: string[] = [];
    for await (const ev of runToolLoop({
      completion: engine,
      executor: makeExecutor(),
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === "text-delta") events.push(ev.delta);
    }
    expect(events.join("")).toBe("Hello, world");
  });

  it("dispatches a tool call to the executor and re-sends with the result", async () => {
    const executor = makeExecutor();
    const calls: any[] = [];
    const engine: ChatCompletionFn = vi.fn(async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) {
        return asStream([
          chunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "start_session", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "done" }), chunk({}, "stop")]);
    });

    const events: any[] = [];
    for await (const ev of runToolLoop({
      completion: engine,
      executor,
      messages: [{ role: "user", content: "start" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }

    expect(executor.startSession).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    const secondCallHistory = calls[1];
    // second call must include the assistant tool_call message AND the tool result
    expect(secondCallHistory.some((m: any) => m.role === "assistant" && m.tool_calls)).toBe(true);
    expect(secondCallHistory.some((m: any) => m.role === "tool" && m.tool_call_id === "call-1")).toBe(true);
    // Final text delta is streamed to caller
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join("")).toBe("done");
  });

  it("executes parallel tool calls in the same turn", async () => {
    const executor = makeExecutor();
    let turn = 0;
    const engine: ChatCompletionFn = async () => {
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({
            tool_calls: [
              { index: 0, id: "a", function: { name: "get_current_code", arguments: '{"session_id":"s"}' } },
              { index: 1, id: "b", function: { name: "get_blocks_svg", arguments: '{"session_id":"s"}' } },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "ok" }), chunk({}, "stop")]);
    };
    for await (const _ of runToolLoop({
      completion: engine,
      executor,
      messages: [{ role: "user", content: "go" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }
    expect(executor.getCurrentCode).toHaveBeenCalledOnce();
    expect(executor.getBlocksSvg).toHaveBeenCalledOnce();
  });

  it("returns a structured tool error when the executor throws", async () => {
    const executor = makeExecutor({
      getBlocksSvg: vi.fn(async () => {
        throw new Error("No code loaded in the editor. Call set_code first to load code before requesting get_blocks_svg.");
      }),
    });
    const capturedHistory: any[][] = [];
    let turn = 0;
    const engine: ChatCompletionFn = async ({ messages }) => {
      capturedHistory.push(messages);
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "get_blocks_svg", arguments: '{"session_id":"s"}' } }] }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "sorry" }), chunk({}, "stop")]);
    };
    for await (const _ of runToolLoop({
      completion: engine,
      executor,
      messages: [{ role: "user", content: "svg please" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }
    const toolMsg = capturedHistory[1].find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/No code loaded/);
  });

  it("re-invokes with empty tools when the model signals done via empty tool_calls", async () => {
    // Hermes-2-Pro-style done signal: schema-constrained output of `[]` produces
    // finish_reason="tool_calls" with no actual calls. The loop must follow up
    // once with tools disabled to let the model emit a plain-text answer.
    const capturedToolsArgs: any[] = [];
    let turn = 0;
    const engine: ChatCompletionFn = async ({ tools }) => {
      capturedToolsArgs.push(tools);
      turn++;
      if (turn === 1) {
        return asStream([chunk({}, "tool_calls")]);
      }
      return asStream([chunk({ content: "All done!" }), chunk({}, "stop")]);
    };
    const events: any[] = [];
    for await (const ev of runToolLoop({
      completion: engine,
      executor: makeExecutor(),
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "start_session", description: "x", parameters: { type: "object", properties: {} } } }] as any,
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    expect(capturedToolsArgs).toHaveLength(2);
    expect(capturedToolsArgs[0]).toHaveLength(1);
    expect(capturedToolsArgs[1]).toEqual([]);
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join("")).toBe("All done!");
  });

  it("stops after maxSteps to avoid infinite loops", async () => {
    const engine: ChatCompletionFn = async () =>
      asStream([
        chunk({ tool_calls: [{ index: 0, id: "x", function: { name: "get_current_code", arguments: '{"session_id":"s"}' } }] }),
        chunk({}, "tool_calls"),
      ]);
    await expect(async () => {
      for await (const _ of runToolLoop({
        completion: engine,
        executor: makeExecutor(),
        messages: [{ role: "user", content: "loop" }],
        tools: [],
        signal: new AbortController().signal,
        maxSteps: 3,
      })) {
        // drain
      }
    }).rejects.toThrow(/max.*step/i);
  });
});
