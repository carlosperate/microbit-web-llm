import type { ThreadMessage } from "@assistant-ui/react";
import {
  HEX_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  stubHexResult,
  stubImageResult,
} from "makecode-mcp/browser";

// Char-based estimate. Exact tokenisation would need a per-model tokenizer
// instance loaded separately; this stays within ~10% on English + MakeCode TS.
export const CHARS_PER_TOKEN = 3.7;
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Image/hex tool results are stubbed in flattenToolHistory (webllm-engine.ts)
// before the model ever sees them, count the stub, not the literal bytes.
function toolCallChars(toolName: string, argsText: string, result: unknown): number {
  let n = argsText.length;
  if (result === undefined) return n;
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  if (IMAGE_TOOL_NAMES.has(toolName)) return n + stubImageResult(resultStr.length).length;
  if (HEX_TOOL_NAMES.has(toolName)) return n + stubHexResult(resultStr.length).length;
  return n + resultStr.length;
}

export function messagesCharCount(messages: readonly ThreadMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === "text") n += p.text.length;
      else if (p.type === "tool-call") n += toolCallChars(p.toolName, p.argsText ?? "", p.result);
    }
  }
  return n;
}

export function estimateUsedTokens({
  messages,
  composerText,
  systemPrompt,
  staticOverheadChars = 0,
}: {
  messages: readonly ThreadMessage[];
  composerText: string;
  systemPrompt: string;
  /** Engine-injected overhead not in the thread state (e.g. tools system prompt). */
  staticOverheadChars?: number;
}): number {
  const chars = systemPrompt.length + staticOverheadChars + messagesCharCount(messages) + composerText.length;
  const overhead = (messages.length + 2) * PER_MESSAGE_OVERHEAD_TOKENS;
  return estimateTokensFromChars(chars) + overhead;
}

export const CONTEXT_WARN_RATIO = 0.7;
export const CONTEXT_FULL_RATIO = 0.9;

export type ContextLevel = "ok" | "warn" | "full";

export function levelForRatio(ratio: number): ContextLevel {
  if (ratio >= CONTEXT_FULL_RATIO) return "full";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}
