import type { ChatModelAdapter, ChatModelRunOptions, ChatModelRunResult } from "@assistant-ui/react";
import type { ThreadMessage, ThreadAssistantMessagePart } from "@assistant-ui/react";
import { tools as TOOL_SCHEMAS } from "makecode-mcp/browser";
import type { MakeCodeExecutor } from "makecode-mcp/browser";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import {
  runToolLoop,
  type ChatCompletionFn,
  type OpenAIMessage,
  type ToolLoopEvent,
} from "./tool-loop.js";

export function convertMessages(messages: readonly ThreadMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      out.push({ role: "system", content: text });
      continue;
    }
    if (m.role === "user") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      out.push({ role: "user", content: text });
      continue;
    }
    // assistant
    let assistantText = "";
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const p of m.content) {
      if (p.type === "text") assistantText += p.text;
      else if (p.type === "tool-call") {
        toolCalls.push({
          id: p.toolCallId,
          type: "function",
          function: { name: p.toolName, arguments: p.argsText ?? JSON.stringify(p.args ?? {}) },
        });
        if (p.result !== undefined) {
          toolResults.push({
            id: p.toolCallId,
            content: typeof p.result === "string" ? p.result : JSON.stringify(p.result),
          });
        }
      }
    }
    out.push({
      role: "assistant",
      content: assistantText || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    for (const r of toolResults) {
      out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

export interface ChatAdapterDeps {
  completion: ChatCompletionFn;
  getExecutor: () => MakeCodeExecutor | null;
}

export function createChatAdapter(deps: ChatAdapterDeps): ChatModelAdapter {
  return {
    async *run(opts: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void> {
      const executor = deps.getExecutor();
      if (!executor) {
        yield {
          status: { type: "incomplete", reason: "error", error: "MakeCode editor is still loading" },
          content: [
            {
              type: "text",
              text: "The MakeCode editor is still loading. Please wait a moment and try again.",
            },
          ],
        };
        return;
      }

      const converted = convertMessages(opts.messages);
      const messages: OpenAIMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...converted];

      const parts: ThreadAssistantMessagePart[] = [];
      let textBuffer = "";

      const flush = (): ChatModelRunResult => ({ content: [...parts, ...(textBuffer ? [{ type: "text", text: textBuffer } as const] : [])] });

      try {
        for await (const ev of runToolLoop({
          completion: deps.completion,
          executor,
          messages,
          tools: TOOL_SCHEMAS,
          signal: opts.abortSignal,
        }) as AsyncIterable<ToolLoopEvent>) {
          if (ev.type === "text-delta") {
            textBuffer += ev.delta;
            yield flush();
          } else if (ev.type === "tool-call") {
            if (textBuffer) {
              parts.push({ type: "text", text: textBuffer });
              textBuffer = "";
            }
            parts.push({
              type: "tool-call",
              toolCallId: ev.id,
              toolName: ev.name,
              args: (ev.args ?? {}) as any,
              argsText: JSON.stringify(ev.args ?? {}),
              result: ev.result,
              isError: ev.isError,
            });
            yield flush();
          }
        }

        if (textBuffer) {
          parts.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        yield { status: { type: "complete", reason: "stop" }, content: parts };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const tailText = textBuffer ? [{ type: "text" as const, text: textBuffer }] : [];
        if (error.name === "AbortError") {
          yield { status: { type: "incomplete", reason: "cancelled" }, content: [...parts, ...tailText] };
          return;
        }
        yield {
          status: { type: "incomplete", reason: "error", error: error.message },
          content: [...parts, ...tailText],
        };
      }
    },
  };
}
