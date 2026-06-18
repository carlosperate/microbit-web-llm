import { describe, it, expect } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import { stubImageResult } from "makecode-mcp/browser";
import {
  CHARS_PER_TOKEN,
  CONTEXT_FULL_RATIO,
  CONTEXT_WARN_RATIO,
  estimateTokensFromChars,
  estimateUsedTokens,
  levelForRatio,
  messagesCharCount,
} from "../src/chat/context-meter.js";

function userMsg(text: string): ThreadMessage {
  return {
    id: text.slice(0, 4),
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date(),
    metadata: {} as any,
    status: { type: "complete", reason: "stop" } as any,
    attachments: [],
  } as unknown as ThreadMessage;
}

function assistantToolCallMsg(toolName: string, args: object, result: string): ThreadMessage {
  return {
    id: `tc-${toolName}`,
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName,
        args,
        argsText: JSON.stringify(args),
        result,
        isError: false,
      },
    ],
    createdAt: new Date(),
    metadata: {} as any,
    status: { type: "complete", reason: "stop" } as any,
    attachments: [],
  } as unknown as ThreadMessage;
}

describe("estimateTokensFromChars", () => {
  it("rounds up and scales by CHARS_PER_TOKEN", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(Math.ceil(CHARS_PER_TOKEN * 100))).toBe(100);
  });
});

describe("messagesCharCount", () => {
  it("sums text content across messages", () => {
    const msgs = [userMsg("hello"), userMsg("world!")];
    expect(messagesCharCount(msgs)).toBe("hello".length + "world!".length);
  });

  it("stubs image tool results — counts the stub the model sees, not the base64", () => {
    // A real PNG result would be ~28KB of base64; the flattened history feeds
    // the model the same short summary produced by `stubImageResult`. The
    // meter must reflect that same length, derived from the same producer.
    const bigBase64 = "x".repeat(30000);
    const m = assistantToolCallMsg("session_get_blocks_img", { code: "x" }, bigBase64);
    const argsLen = JSON.stringify({ code: "x" }).length;
    expect(messagesCharCount([m])).toBe(argsLen + stubImageResult(bigBase64.length).length);
  });

  it("counts non-stubbed tool results literally", () => {
    const result = "function basic.showString called";
    const m = assistantToolCallMsg("session_get_code", {}, result);
    const argsLen = "{}".length;
    expect(messagesCharCount([m])).toBe(argsLen + result.length);
  });
});

describe("estimateUsedTokens", () => {
  it("counts system prompt, history, composer text, and grows with composer length", () => {
    const args = { messages: [userMsg("hi")], systemPrompt: "you are helpful" };
    const empty = estimateUsedTokens({ ...args, composerText: "" });
    const typed = estimateUsedTokens({ ...args, composerText: "x".repeat(1000) });
    expect(empty).toBeGreaterThan(0);
    expect(typed).toBeGreaterThan(empty);
  });
});

describe("levelForRatio", () => {
  it("transitions ok → warn → full at the configured thresholds", () => {
    expect(levelForRatio(0)).toBe("ok");
    expect(levelForRatio(CONTEXT_WARN_RATIO - 0.01)).toBe("ok");
    expect(levelForRatio(CONTEXT_WARN_RATIO)).toBe("warn");
    expect(levelForRatio(CONTEXT_FULL_RATIO - 0.01)).toBe("warn");
    expect(levelForRatio(CONTEXT_FULL_RATIO)).toBe("full");
    expect(levelForRatio(1.5)).toBe("full");
  });
});
