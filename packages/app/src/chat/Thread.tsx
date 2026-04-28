import {
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";

export function Thread() {
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
      <Composer />
    </ThreadPrimitive.Root>
  );
}

const TextPart = () => <MessagePartPrimitive.Text />;

function EmptyState() {
  return (
    <div className="thread-empty">
      <h2>micro:bit coding assistant</h2>
      <p>Ask me to write or explain a micro:bit program. I can load code into the editor on the right, render it as blocks, or compile a .hex file.</p>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-content">
        <MessagePrimitive.Parts
          components={{
            Text: TextPart,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="message-content">
        <MessagePrimitive.Parts
          components={{
            Text: TextPart,
            tools: { Fallback: ToolCallView },
          }}
        />
        <AssistantError />
      </div>
    </MessagePrimitive.Root>
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
  const pngBase64 = !isError ? extractPngBase64(resultText) : null;
  return (
    <details className={`tool-call ${isError ? "tool-call-error" : ""}`}>
      <summary>
        <code>{toolName}</code>
        {isError && <span className="tool-call-badge">error</span>}
      </summary>
      <div className="tool-call-body">
        <div className="tool-call-args">
          <strong>args:</strong> <code>{argsText || "{}"}</code>
        </div>
        {resultText !== null && (
          <div className="tool-call-result">
            <strong>result:</strong>
            {pngBase64 ? (
              <div className="tool-call-image">
                <img
                  src={`data:image/png;base64,${pngBase64}`}
                  alt="MakeCode blocks"
                />
              </div>
            ) : (
              <pre>{truncate(resultText, 2000)}</pre>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function extractPngBase64(resultText: string | null): string | null {
  if (!resultText) return null;
  const trimmed = resultText.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const png = parsed?.pngBase64;
    return typeof png === "string" && png.length > 0 ? png : null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input
        rows={2}
        autoFocus
        placeholder="Ask for a micro:bit program…"
        className="composer-input"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="composer-cancel">Stop</ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}
