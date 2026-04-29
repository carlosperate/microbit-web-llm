import type { ChatModelAdapter, ChatModelRunOptions, ChatModelRunResult } from "@assistant-ui/react";
import type { ThreadMessage, ThreadAssistantMessagePart } from "@assistant-ui/react";
import { tools as TOOL_SCHEMAS } from "makecode-mcp/browser";
import type { BrowserExecutor } from "makecode-mcp/browser";
import { createLogger, preview } from "makecode-mcp/browser";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import {
  runToolLoop,
  type ChatCompletionFn,
  type OpenAIMessage,
  type ToolLoopEvent,
} from "./tool-loop.js";

const log = createLogger("adapter");

function pngFromResult(result: string): string | null {
  if (!result || !result.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(result);
    const png = parsed?.pngBase64;
    return typeof png === "string" && png.length > 0 ? png : null;
  } catch {
    return null;
  }
}

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
    // WebLLM's `ContentTypeError` requires assistant `content` to be a string,
    // even when `tool_calls` is present. Use "" rather than null for tool-only
    // turns so subsequent inferences don't fail with
    // "assistant's message should have string content."
    out.push({
      role: "assistant",
      content: assistantText,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    for (const r of toolResults) {
      out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

export interface AdapterRuntimeSettings {
  systemPrompt: string;
  temperature: number;
  maxTokens: number | null;
  maxSteps: number;
}

export interface ChatAdapterDeps {
  completion: ChatCompletionFn;
  getExecutor: () => BrowserExecutor | null;
  /** Read live settings on each turn; never close over a stale snapshot. */
  getSettings: () => AdapterRuntimeSettings;
}

export function createChatAdapter(deps: ChatAdapterDeps): ChatModelAdapter {
  return {
    async *run(opts: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void> {
      const executor = deps.getExecutor();
      const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
      const lastText =
        lastUser?.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("") ?? "";
      log.group(`run() turn: ${preview(lastText, 80)}`);
      log.info("run() starting", {
        messages: opts.messages.length,
        executorReady: !!executor,
      });
      if (!executor) {
        log.warn("run() → no executor yet (editor still loading)");
        log.groupEnd();
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

      const settings = deps.getSettings();
      const converted = convertMessages(opts.messages);
      const systemPrompt = settings.systemPrompt.trim() || SYSTEM_PROMPT;
      const messages: OpenAIMessage[] = [{ role: "system", content: systemPrompt }, ...converted];
      log.debug("messages prepared", {
        total: messages.length,
        roles: messages.map((m) => m.role),
      });

      const parts: ThreadAssistantMessagePart[] = [];
      let textBuffer = "";
      let totalTextChars = 0;
      let toolCallCount = 0;

      const flush = (): ChatModelRunResult => ({ content: [...parts, ...(textBuffer ? [{ type: "text", text: textBuffer } as const] : [])] });

      try {
        for await (const ev of runToolLoop({
          completion: deps.completion,
          executor,
          messages,
          tools: TOOL_SCHEMAS,
          signal: opts.abortSignal,
          maxSteps: settings.maxSteps,
          completionOptions: {
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
          },
        }) as AsyncIterable<ToolLoopEvent>) {
          if (ev.type === "text-delta") {
            textBuffer += ev.delta;
            totalTextChars += ev.delta.length;
            yield flush();
          } else if (ev.type === "tool-call") {
            toolCallCount++;
            log.info(`tool-call event → ${ev.name}`, {
              isError: ev.isError,
              resultBytes: ev.result.length,
            });
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
            // Render a blocks-image tool result inline as an image part so
            // the user sees the rendered blocks alongside the call card.
            // Mirrors what the MCP server emits as `image` content blocks.
            if (!ev.isError && ev.name.startsWith("get_blocks_image")) {
              const png = pngFromResult(ev.result);
              if (png) parts.push({ type: "image", image: `data:image/png;base64,${png}` });
            }
            yield flush();
          }
        }

        if (textBuffer) {
          parts.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        log.info("run() complete", { toolCallCount, totalTextChars });
        log.groupEnd();
        yield { status: { type: "complete", reason: "stop" }, content: parts };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const tailText = textBuffer ? [{ type: "text" as const, text: textBuffer }] : [];
        if (error.name === "AbortError") {
          log.warn("run() cancelled", { toolCallCount, totalTextChars });
          log.groupEnd();
          yield { status: { type: "incomplete", reason: "cancelled" }, content: [...parts, ...tailText] };
          return;
        }
        log.error("run() error", error);
        log.groupEnd();
        yield {
          status: { type: "incomplete", reason: "error", error: error.message },
          content: [...parts, ...tailText],
        };
      }
    },
  };
}
