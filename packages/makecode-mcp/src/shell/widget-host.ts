// The MCP Apps (SEP-1865) host protocol, hand-rolled: a JSON-RPC handshake over
// postMessage. Kept separate from the widget wiring so the session-id walk can
// be tested without a browser.

const PROTOCOL_VERSION = "2026-01-26";

/** Hosts differ in how they wrap a tool result, so walk rather than couple. */
export function findSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.session_id === "string" && record.session_id) return record.session_id;
  if (record.type === "text" && typeof record.text === "string") {
    try {
      const found = findSessionId(JSON.parse(record.text));
      if (found) return found;
    } catch {
      // Not JSON: nothing to find here.
    }
  }
  for (const key of Object.keys(record)) {
    const found = findSessionId(record[key]);
    if (found) return found;
  }
  return null;
}

/** Hosts start a widget short; an editor has to ask for room. */
export function sizeMessage(width: number, height: number) {
  return {
    jsonrpc: "2.0" as const,
    method: "ui/notifications/size-changed",
    params: { width: Math.ceil(width), height: Math.ceil(height) },
  };
}

export interface HostHandlers {
  onToolResult(params: unknown): void;
  onError(message: string): void;
  /** The ui/initialize result, which carries the host's capabilities. */
  onInitialized?(result: unknown): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(message: string): void;
}

/** Asks the host to make this widget `height` tall. */
export function requestHeight(height: number): void {
  window.parent.postMessage(sizeMessage(window.innerWidth || 800, height), "*");
}

/** Performs the handshake and routes notifications; resolves with the result. */
export function connectHost(handlers: HostHandlers): void {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const send = (msg: unknown) => window.parent.postMessage(msg, "*");

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id as number);
      if (!entry) return;
      pending.delete(msg.id as number);
      // A host that refuses the handshake must not look like an empty result,
      // or the widget reports "no session" instead of what actually happened.
      const error = msg.error as { message?: string } | undefined;
      if (error) entry.reject(error.message ?? "the host refused ui/initialize");
      else entry.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === "string") {
      // Answer pings; refuse anything else rather than hanging the host.
      if (msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} });
      else
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      return;
    }
    if (msg.method === "ui/notifications/tool-result") handlers.onToolResult(msg.params);
  });

  const id = nextId++;
  pending.set(id, {
    resolve: (result) => {
      handlers.onInitialized?.(result);
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      // Some hosts hand the triggering result back here instead of notifying.
      handlers.onToolResult(result);
    },
    reject: (message) => handlers.onError(`Host handshake failed: ${message}`),
  });
  send({
    jsonrpc: "2.0",
    id,
    method: "ui/initialize",
    params: {
      appInfo: { name: "makecode-session-editor", version: "2.0.0" },
      appCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    },
  });
}
