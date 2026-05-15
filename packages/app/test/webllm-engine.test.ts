import { describe, it, expect } from "vitest";
import {
  flattenToolHistory,
  toWebLLMMessages,
  TOOL_CONTINUATION_PROMPT,
} from "../src/chat/webllm-engine.js";
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

describe("flattenToolHistory", () => {
  it("collapses assistant{tool_calls} + following tool messages into one assistant turn", () => {
    const history: OpenAIMessage[] = [
      { role: "user", content: "show me blocks" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: TOOL.SESSION_GET_CODE, arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "let x = 0" },
    ];
    const out = flattenToolHistory(history);
    // user, collapsed-assistant, appended user continuation
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "show me blocks" });
    expect(out[1].role).toBe("assistant");
    const collapsed = out[1] as { role: "assistant"; content: string };
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
          {
            id: "c1",
            type: "function",
            function: { name: TOOL.SESSION_GET_BLOCKS_IMG, arguments: "{}" },
          },
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

  it("stubs hex tool results instead of dumping bytes", () => {
    const fakeHex = "B".repeat(50_000);
    const result = encodeHex(fakeHex);
    const history: OpenAIMessage[] = [
      { role: "user", content: "compile" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c2",
            type: "function",
            function: { name: TOOL.SESSION_GET_HEX_FILE, arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: result },
    ];
    const out = flattenToolHistory(history);
    const collapsed = out[1] as { role: "assistant"; content: string };
    expect(collapsed.content).not.toContain(fakeHex);
    expect(collapsed.content).toContain("hex compiled");
    expect(collapsed.content).toContain("not shown");
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
      `"(Tool results above. The original task is most likely complete now — stop calling tools so you can give the student a short plain-text explanation on the next turn. Only emit another tool call if the original task genuinely is not finished and the next call will clearly advance it. Do not repeat a tool you already called, do not call session_get_hex_file unless the student asked for it, and do not call any image tool just to look at code.)"`,
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
