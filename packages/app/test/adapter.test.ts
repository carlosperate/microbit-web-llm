import { describe, it, expect, vi } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import type { MakeCodeExecutor } from "makecode-mcp/browser";
import { convertMessages, createChatAdapter } from "../src/chat/adapter.js";
import type { ChatCompletionFn, StreamChunk } from "../src/chat/tool-loop.js";

function userMsg(text: string): ThreadMessage {
  return {
    id: "u",
    createdAt: new Date(),
    role: "user",
    content: [{ type: "text", text }],
    attachments: [],
    metadata: { custom: {} },
  } as unknown as ThreadMessage;
}

function assistantMsg(parts: any[]): ThreadMessage {
  return {
    id: "a",
    createdAt: new Date(),
    role: "assistant",
    content: parts,
    status: { type: "complete" },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [] },
  } as unknown as ThreadMessage;
}

function makeExecutor(overrides: Partial<MakeCodeExecutor> = {}): MakeCodeExecutor {
  return {
    startSession: vi.fn(async () => ({ session_id: "sid-1" })),
    endSession: vi.fn(async () => {}),
    getCurrentCode: vi.fn(async () => ""),
    setCode: vi.fn(async () => {}),
    getBlocksSvg: vi.fn(async () => "<svg/>"),
    getHexFile: vi.fn(async () => ""),
    getBlocksSvgFromCode: vi.fn(async () => "<svg/>"),
    getHexFileFromCode: vi.fn(async () => ""),
    ...overrides,
  };
}

function chunk(delta: Partial<StreamChunk["choices"][0]["delta"]>, finish_reason: StreamChunk["choices"][0]["finish_reason"] = null): StreamChunk {
  return { choices: [{ delta, finish_reason }] };
}
async function* asStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const c of chunks) yield c;
}

describe("convertMessages", () => {
  it("converts a user text message", () => {
    expect(convertMessages([userMsg("hello")])).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("pairs assistant tool-call parts with a following tool-result message", () => {
    const out = convertMessages([
      assistantMsg([
        { type: "text", text: "ok" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "set_code",
          args: { session_id: "s", code: "x" },
          argsText: '{"session_id":"s","code":"x"}',
          result: '{"ok":true}',
        },
      ]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      role: "assistant",
      content: "ok",
      tool_calls: [{ id: "c1", type: "function", function: { name: "set_code" } }],
    });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
  });

  it("omits tool_calls when there are none and keeps content null if empty", () => {
    const out = convertMessages([assistantMsg([])]);
    expect(out[0]).toEqual({ role: "assistant", content: null });
  });
});

describe("createChatAdapter", () => {
  async function drain(gen: AsyncGenerator<any>) {
    const results: any[] = [];
    for await (const r of gen) results.push(r);
    return results;
  }

  function makeOpts(messages: ThreadMessage[]) {
    return {
      messages,
      runConfig: {},
      abortSignal: new AbortController().signal,
      context: {},
      config: {},
      unstable_getMessage: () => messages[messages.length - 1]!,
    } as any;
  }

  it("reports an error when the executor is not ready", async () => {
    const completion: ChatCompletionFn = async () => asStream([chunk({ content: "hi" }, "stop")]);
    const adapter = createChatAdapter({ completion, getExecutor: () => null });
    const results = await drain(adapter.run(makeOpts([userMsg("hi")])) as AsyncGenerator<any>);
    const last = results[results.length - 1];
    expect(last.status.type).toBe("incomplete");
    expect(last.status.reason).toBe("error");
  });

  it("streams text and completes with status=complete", async () => {
    const completion: ChatCompletionFn = async () =>
      asStream([chunk({ content: "Hello" }), chunk({ content: " world" }), chunk({}, "stop")]);
    const adapter = createChatAdapter({ completion, getExecutor: () => makeExecutor() });
    const results = await drain(adapter.run(makeOpts([userMsg("hi")])) as AsyncGenerator<any>);
    const final = results[results.length - 1];
    expect(final.status).toEqual({ type: "complete", reason: "stop" });
    expect(final.content.map((p: any) => p.text).join("")).toBe("Hello world");
  });

  it("emits a tool-call part with args and result when the model invokes a tool", async () => {
    const executor = makeExecutor();
    let turn = 0;
    const completion: ChatCompletionFn = async () => {
      turn++;
      if (turn === 1) {
        return asStream([
          chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "start_session", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ]);
      }
      return asStream([chunk({ content: "done" }), chunk({}, "stop")]);
    };
    const adapter = createChatAdapter({ completion, getExecutor: () => executor });
    const results = await drain(adapter.run(makeOpts([userMsg("go")])) as AsyncGenerator<any>);
    const final = results[results.length - 1];
    const toolPart = final.content.find((p: any) => p.type === "tool-call");
    expect(toolPart).toMatchObject({
      toolCallId: "t1",
      toolName: "start_session",
      isError: false,
    });
    expect(toolPart.result).toContain("session_id");
    expect(executor.startSession).toHaveBeenCalledOnce();
  });

  it("reports error status without duplicating the message in content", async () => {
    const completion: ChatCompletionFn = async () => {
      throw new Error("boom");
    };
    const adapter = createChatAdapter({ completion, getExecutor: () => makeExecutor() });
    const results = await drain(adapter.run(makeOpts([userMsg("x")])) as AsyncGenerator<any>);
    const final = results[results.length - 1];
    expect(final.status).toEqual({ type: "incomplete", reason: "error", error: "boom" });
    const joinedText = final.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    expect(joinedText).not.toContain("boom");
    expect(joinedText).not.toMatch(/_Error/i);
  });
});
