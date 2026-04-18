import {
  ComposerPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";

export function Thread({ modelReady = true }: { modelReady?: boolean }) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Empty>
          {modelReady ? <EmptyState /> : <ModelNotLoaded />}
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      <Composer disabled={!modelReady} />
    </ThreadPrimitive.Root>
  );
}

function ModelNotLoaded() {
  return (
    <div className="thread-empty" data-testid="model-not-loaded">
      <h2>Load a model to begin</h2>
      <p>Pick a model from the dropdown above and click <strong>Load model</strong>. The first load downloads ~4–5 GB and is cached for future visits.</p>
    </div>
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
  const isSvg = typeof resultText === "string" && resultText.trim().startsWith("<svg");
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
            {isSvg ? (
              <div className="tool-call-svg" dangerouslySetInnerHTML={{ __html: resultText }} />
            ) : (
              <pre>{truncate(resultText, 2000)}</pre>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

function Composer({ disabled = false }: { disabled?: boolean }) {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input
        rows={2}
        autoFocus
        placeholder={disabled ? "Load a model to start chatting…" : "Ask for a micro:bit program…"}
        className="composer-input"
        disabled={disabled}
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="composer-send" disabled={disabled}>Send</ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="composer-cancel">Stop</ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}
