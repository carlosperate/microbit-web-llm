import type { ReactNode } from "react";
import {
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useMessage,
  useMessagePartText,
} from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { IMAGE_TOOL_NAMES } from "makecode-mcp/browser";

export function Thread({ composerSlot }: { composerSlot?: ReactNode } = {}) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Empty>
          <EmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      {composerSlot !== undefined ? composerSlot : <Composer />}
    </ThreadPrimitive.Root>
  );
}

const TextPart = () => (
  <div className="text-part">
    <MessagePartPrimitive.Text />
  </div>
);

// Some models emit malformed fenced blocks like "```ts code...```".
// Normalise those to standard fenced markdown so the renderer can parse them.
function normalizeFences(text: string): string {
  return text.replace(/```([a-zA-Z0-9_-]+)[ \t]+([^\n][\s\S]*?)```/g, (_m, lang, code) => {
    const trimmed = String(code).trim();
    return `\n\n\`\`\`${lang}\n${trimmed}\n\`\`\`\n\n`;
  });
}

function AssistantTextPart() {
  const part = useMessagePartText();
  const markdown = normalizeFences(part.text ?? "");
  return (
    <div className="text-part assistant-markdown">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="thread-empty">
      <h2>micro:bit coding assistant</h2>
      <p>Ask me to write or explain a micro:bit program. I can load code into the editor on the right, render it as blocks, or compile a .hex file.</p>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="thinking-indicator" aria-live="polite" aria-label="Assistant is thinking">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <MessagePrimitive.Parts components={{ Text: TextPart }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const msg = useMessage();
  const hasContent = msg.content.length > 0;
  const isRunning = msg.status?.type === "running";
  if (!hasContent && isRunning) {
    return (
      <MessagePrimitive.Root className="message message-assistant">
        <ThinkingIndicator />
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="message-content message-content-parts">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantTextPart,
            Image: ImagePart,
            tools: { Fallback: ToolCallView },
          }}
        />
        {isRunning && <ThinkingIndicator />}
        <AssistantError />
      </div>
    </MessagePrimitive.Root>
  );
}

function ImagePart({ image }: { image: string }) {
  return (
    <div className="image-part">
      <img src={image} alt="MakeCode blocks" />
    </div>
  );
}

function AssistantError() {
  const msg = useMessage();
  if (msg.role !== "assistant") return null;
  if (msg.status.type !== "incomplete" || msg.status.reason !== "error") return null;
  const error = (msg.status as { error?: unknown }).error;
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
  return <div className="message-error">⚠ {text}</div>;
}

function ToolCallView({
  toolName,
  argsText,
  result,
  isError,
}: {
  toolName: string;
  argsText: string;
  result?: unknown;
  isError?: boolean;
}) {
  const resultText = result === undefined ? null : typeof result === "string" ? result : JSON.stringify(result);
  const isImageTool = !isError && IMAGE_TOOL_NAMES.has(toolName);
  const isPending = result === undefined && !isError;

  return (
    <details className={`tool-call${isError ? " tool-call-error" : ""}`}>
      <summary>
        {isPending ? (
          <span className="tool-call-status-pend">…</span>
        ) : isError ? (
          <span className="tool-call-status-err">✗</span>
        ) : (
          <span className="tool-call-status-ok">✓</span>
        )}
        <code className="tool-call-name">{toolName}</code>
        <span className="tool-call-chevron">▼</span>
      </summary>
      <div className="tool-call-body">
        <div className="tool-call-body-name">{toolName}()</div>
        <div className="tool-call-args">
          args: <span>{argsText || "{}"}</span>
        </div>
        {resultText !== null && !isImageTool && (
          <div className="tool-call-result">
            result:
            <pre>{truncate(resultText, 2000)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="composer">
      <div className="composer-inner">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder="Ask for a micro:bit program…"
          className="composer-input"
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="composer-send">↑</ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="composer-cancel">■</ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
}
