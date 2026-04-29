import { describe, it, expect, vi } from "vitest";
import { runToolLoop } from "../src/chat/tool-loop.js";
import type { ChatCompletionFn, StreamChunk } from "../src/chat/tool-loop.js";
import type { BrowserExecutor } from "makecode-mcp/browser";

function makeExecutor(overrides: Partial<BrowserExecutor> = {}): BrowserExecutor {
  return {
    getCurrentCode: vi.fn(async () => ""),
    setCode: vi.fn(async () => {}),
    getBlocksImage: vi.fn(async () => ({ pngBase64: "iVBORw0KGgo=" })),
    getHexFile: vi.fn(async () => "aGV4"),
    getBlocksImageFromCode: vi.fn(async () => ({ pngBase64: "iVBORw0KGgo=" })),
    ...overrides,
  };
}

function chunk(
  delta: Partial<StreamChunk["choices"][0]["delta"]>,
  finish_reason: StreamChunk["choices"][0]["finish_reason"] = null,
): StreamChunk {
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
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "set_code", arguments: '{"code":"basic.showNumber(1)"}' },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "done" }), chunk({}, "stop")]);
    });

    const events: any[] = [];
    for await (const ev of runToolLoop({
      completion: engine,
      executor,
      messages: [{ role: "user", content: "write a program" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }

    expect(executor.setCode).toHaveBeenCalledWith("basic.showNumber(1)");
    expect(calls).toHaveLength(2);
    const secondCallHistory = calls[1];
    expect(
      secondCallHistory.some((m: any) => m.role === "assistant" && m.tool_calls),
    ).toBe(true);
    expect(
      secondCallHistory.some((m: any) => m.role === "tool" && m.tool_call_id === "call-1"),
    ).toBe(true);
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join("")).toBe("done");
  });

  it("executes multiple tool calls in the same turn sequentially in emission order", async () => {
    // The model frequently emits set_code + get_blocks_image (and sometimes
    // get_current_code beforehand) in a single batch. Running them in
    // parallel races: get_blocks_image returns in ~17ms while set_code is
    // still in flight (~2s for MakeCode to ingest), so blocks render against
    // the pre-set state and throw EMPTY_EDITOR_ERROR. Serialising preserves
    // the model's intended ordering.
    let setCodeResolved = false;
    let getBlocksStartedBeforeSetCode = false;
    const executor = makeExecutor({
      setCode: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        setCodeResolved = true;
      }),
      getBlocksImage: vi.fn(async () => {
        if (!setCodeResolved) getBlocksStartedBeforeSetCode = true;
        return { pngBase64: "iVBORw0KGgo=" };
      }),
    });
    let turn = 0;
    const engine: ChatCompletionFn = async () => {
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({
            tool_calls: [
              { index: 0, id: "a", function: { name: "get_current_code", arguments: "{}" } },
              { index: 1, id: "b", function: { name: "set_code", arguments: '{"code":"basic.showNumber(1)"}' } },
              { index: 2, id: "c", function: { name: "get_blocks_image", arguments: "{}" } },
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
    expect(executor.setCode).toHaveBeenCalledOnce();
    expect(executor.getBlocksImage).toHaveBeenCalledOnce();
    expect(getBlocksStartedBeforeSetCode).toBe(false);
  });

  it("passes get_blocks_image_from_code through as a stateless render", async () => {
    // Useful for previewing a snippet while the user is still discussing
    // changes, before anything is loaded into the editor.
    const executor = makeExecutor({
      getBlocksImageFromCode: vi.fn(async (_c: string) => ({ pngBase64: "iVBORw0KGgoZ" })),
    });
    let turn = 0;
    const engine: ChatCompletionFn = async () => {
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "p1",
                function: { name: "get_blocks_image_from_code", arguments: '{"code":"basic.showNumber(42)"}' },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "here's a preview" }), chunk({}, "stop")]);
    };
    for await (const _ of runToolLoop({
      completion: engine,
      executor,
      messages: [{ role: "user", content: "show me what this looks like" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }
    expect(executor.getBlocksImageFromCode).toHaveBeenCalledWith("basic.showNumber(42)");
    expect(executor.setCode).not.toHaveBeenCalled();
  });

  it("returns a structured tool error when the executor throws", async () => {
    const executor = makeExecutor({
      getBlocksImage: vi.fn(async () => {
        throw new Error(
          "No code loaded in the editor. Call set_code first to load code before requesting get_blocks_image.",
        );
      }),
    });
    const capturedHistory: any[][] = [];
    let turn = 0;
    const engine: ChatCompletionFn = async ({ messages }) => {
      capturedHistory.push(messages);
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({
            tool_calls: [
              { index: 0, id: "c", function: { name: "get_blocks_image", arguments: "{}" } },
            ],
          }),
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

  it("re-invokes with empty tools when the model signals done via [] after substantive work", async () => {
    // Hermes-2-Pro-style done signal: schema-constrained output of `[]` with
    // finish_reason="tool_calls" means "nothing more to do". After substantive
    // work has happened, the loop follows up once with tools disabled so the
    // model can emit a plain-text wrap-up.
    const capturedToolsArgs: any[] = [];
    let turn = 0;
    const engine: ChatCompletionFn = async ({ tools }) => {
      capturedToolsArgs.push(tools);
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({
            tool_calls: [
              { index: 0, id: "c1", function: { name: "set_code", arguments: '{"code":"x"}' } },
            ],
          }),
          chunk({}, "tool_calls"),
        ]);
      }
      if (turn === 2) return asStream([chunk({}, "tool_calls")]);
      return asStream([chunk({ content: "All done!" }), chunk({}, "stop")]);
    };
    const events: any[] = [];
    for await (const ev of runToolLoop({
      completion: engine,
      executor: makeExecutor(),
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: { name: "set_code", description: "x", parameters: { type: "object", properties: {} } },
        },
      ] as any,
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    expect(capturedToolsArgs).toHaveLength(3);
    expect(capturedToolsArgs[0]).toHaveLength(1);
    expect(capturedToolsArgs[1]).toHaveLength(1);
    expect(capturedToolsArgs[2]).toEqual([]);
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join("")).toBe("All done!");
  });

  describe("stall recovery", () => {
    it("retries once with a system nudge when the model stalls on turn 1 (no tool calls yet)", async () => {
      // Observed with Qwen + grammar-constrained tool calling: user asks for
      // something actionable, model emits [] on turn 1 instead of calling a
      // tool. Without retry, the fallback produces plain-text output that
      // describes tool calls inside a code block (unrunnable).
      const executor = makeExecutor();
      const callsReceived: any[] = [];
      let turn = 0;
      const engine: ChatCompletionFn = async (params) => {
        callsReceived.push({ messages: params.messages, tools: params.tools });
        turn++;
        if (turn === 1) {
          // Stall on turn 1 — no tool calls at all.
          return asStream([chunk({}, "tool_calls")]);
        }
        if (turn === 2) {
          return asStream([
            chunk({
              tool_calls: [
                { index: 0, id: "c1", function: { name: "set_code", arguments: '{"code":"basic.showString(\\"Jerry\\")"}' } },
              ],
            }),
            chunk({}, "tool_calls"),
          ]);
        }
        return asStream([chunk({ content: "done" }), chunk({}, "stop")]);
      };
      const events: any[] = [];
      for await (const ev of runToolLoop({
        completion: engine,
        executor,
        messages: [{ role: "user", content: "scroll Jerry" }],
        tools: [
          {
            type: "function",
            function: { name: "set_code", description: "x", parameters: { type: "object", properties: {}, required: [] } },
          },
        ] as any,
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }
      // Turn 2 still has tools (retry, not fallback).
      expect(callsReceived[1]?.tools.length).toBeGreaterThan(0);
      // Turn 2 received a system reminder after the turn-1 stall.
      const turn2Systems = callsReceived[1].messages.filter((m: any) => m.role === "system");
      expect(turn2Systems.length).toBeGreaterThanOrEqual(1);
      expect(turn2Systems[turn2Systems.length - 1].content).toMatch(/tool|plain text|workflow/i);
      expect(executor.setCode).toHaveBeenCalledWith('basic.showString("Jerry")');
    });

    it("falls back to plain-text reply when the stall persists after the retry", async () => {
      const sawEmptyTools: boolean[] = [];
      let turn = 0;
      const engine: ChatCompletionFn = async ({ tools }) => {
        sawEmptyTools.push(tools.length === 0);
        turn++;
        if (turn === 1 || turn === 2) return asStream([chunk({}, "tool_calls")]);
        return asStream([chunk({ content: "sorry, I can't." }), chunk({}, "stop")]);
      };
      const events: any[] = [];
      for await (const ev of runToolLoop({
        completion: engine,
        executor: makeExecutor(),
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            type: "function",
            function: { name: "set_code", description: "x", parameters: { type: "object", properties: {}, required: [] } },
          },
        ] as any,
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }
      // Turn 1 (initial stall) + turn 2 (retry) keep tools; turn 3 (plain-text
      // fallback) is the first with tools disabled.
      expect(sawEmptyTools.slice(0, 2).every((v) => v === false)).toBe(true);
      expect(sawEmptyTools[2]).toBe(true);
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join("")).toBe("sorry, I can't.");
    });

    it("does not retry the stall if substantive work has already happened", async () => {
      // Turn 1: set_code (substantive).
      // Turn 2: []. No stall retry — proceed to tools-disabled text fallback.
      const executor = makeExecutor();
      let turn = 0;
      const sawEmptyTools: boolean[] = [];
      const engine: ChatCompletionFn = async ({ tools }) => {
        sawEmptyTools.push(tools.length === 0);
        turn++;
        if (turn === 1) {
          return asStream([
            chunk({
              tool_calls: [
                { index: 0, id: "c1", function: { name: "set_code", arguments: '{"code":"x"}' } },
              ],
            }),
            chunk({}, "tool_calls"),
          ]);
        }
        if (turn === 2) return asStream([chunk({}, "tool_calls")]);
        return asStream([chunk({ content: "done" }), chunk({}, "stop")]);
      };
      for await (const _ of runToolLoop({
        completion: engine,
        executor,
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            type: "function",
            function: { name: "set_code", description: "x", parameters: { type: "object", properties: {}, required: [] } },
          },
        ] as any,
        signal: new AbortController().signal,
      })) {
        // drain
      }
      // Turn 3 is the tools-disabled fallback; no retry turn between.
      expect(sawEmptyTools).toEqual([false, false, true]);
    });

    it("merges the stall reminder into an existing leading system message instead of appending a second one", async () => {
      // Regression: WebLLM's native tool-calling path (Hermes-3) throws
      // SystemMessageOrderError if any system message appears after index 0,
      // so the retry must extend the leading system message rather than push
      // a new one.
      let turn = 0;
      const callsReceived: any[] = [];
      const engine: ChatCompletionFn = async ({ messages }) => {
        callsReceived.push(messages);
        turn++;
        if (turn === 1 || turn === 2) return asStream([chunk({}, "tool_calls")]);
        return asStream([chunk({ content: "ok" }), chunk({}, "stop")]);
      };
      for await (const _ of runToolLoop({
        completion: engine,
        executor: makeExecutor(),
        messages: [
          { role: "system", content: "ORIGINAL_SYSTEM" },
          { role: "user", content: "go" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "set_code", description: "x", parameters: { type: "object", properties: {}, required: [] } },
          },
        ] as any,
        signal: new AbortController().signal,
      })) {
        // drain
      }
      // After the retry, the second call's history must still have exactly one
      // system message — at index 0 — containing both the original prompt and
      // the merged reminder.
      const turn2 = callsReceived[1];
      const systems = turn2.filter((m: any) => m.role === "system");
      expect(systems).toHaveLength(1);
      expect(turn2[0].role).toBe("system");
      expect(turn2[0].content).toContain("ORIGINAL_SYSTEM");
      expect(turn2[0].content).toMatch(/workflow|tool/i);
    });
  });

  it("forwards completionOptions (temperature, maxTokens) to the completion fn", async () => {
    const seen: any[] = [];
    const engine: ChatCompletionFn = async (params) => {
      seen.push(params.options);
      return asStream([chunk({ content: "hi" }), chunk({}, "stop")]);
    };
    for await (const _ of runToolLoop({
      completion: engine,
      executor: makeExecutor(),
      messages: [{ role: "user", content: "go" }],
      tools: [],
      signal: new AbortController().signal,
      completionOptions: { temperature: 0.3, maxTokens: 256 },
    })) {
      // drain
    }
    expect(seen[0]).toEqual({ temperature: 0.3, maxTokens: 256 });
  });

  it("stops after maxSteps to avoid infinite loops", async () => {
    const engine: ChatCompletionFn = async () =>
      asStream([
        chunk({
          tool_calls: [
            { index: 0, id: "x", function: { name: "get_current_code", arguments: "{}" } },
          ],
        }),
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
