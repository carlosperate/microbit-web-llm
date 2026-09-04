import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger, preview } from "../shared/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionView, ViewMessage, ViewRegistry } from "./view-registry.js";

const log = createLogger("widget-channel");

// The bridge iframe is same-origin with this server, so a plain SSE stream
// (server → view) plus a POST (view → server) is all the widget needs; there
// is no request/response traffic to justify a WebSocket dependency. Tool calls
// never wait on a view.
const EVENTS_PATH = "/widget/events";
const SAVE_PATH = "/widget/save";
/** Comfortably above a real MakeCode project, far below anything that could
 *  exhaust memory if something starts POSTing junk. */
const MAX_SAVE_BYTES = 8 * 1024 * 1024;
/** Keeps proxies and idle-socket reapers from dropping a quiet stream. */
const HEARTBEAT_MS = 25_000;

export interface WidgetChannelOptions {
  store: SessionStore;
  views: ViewRegistry;
  /** Shared secret minted at startup; every widget request must carry it. */
  token: string;
  /** This server's own origin; the base for parsing request URLs. */
  origin: string;
}

export interface WidgetChannel {
  /** True if the request belonged to the widget channel and was answered. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  close(): void;
}

export function createWidgetChannel(opts: WidgetChannelOptions): WidgetChannel {
  const { store, views, token, origin } = opts;

  // Views only ever learn about state through the store's change feed, so a
  // tool write and a user edit from another view look the same to them.
  const unsubscribe = store.subscribe((change) => {
    if (change.type === "committed" && change.record) {
      views.broadcast(
        change.sessionId,
        { type: "project", version: change.record.version, files: { ...change.record.files } },
        change.source !== undefined ? { except: change.source } : {},
      );
    } else if (change.type === "removed") {
      views.broadcast(change.sessionId, { type: "session-gone" });
      views.closeAll(change.sessionId);
    }
  });

  // The bridge runs at an opaque origin under the host's sandbox, so every
  // request it makes to us is cross-origin and needs CORS to be readable — the
  // token, not the origin, is what actually gates access.
  const cors = (req: IncomingMessage): Record<string, string> => ({
    "access-control-allow-origin": req.headers.origin ?? "*",
    vary: "Origin",
  });

  const deny = (req: IncomingMessage, res: ServerResponse, status: number, error: string) => {
    res
      .writeHead(status, { "content-type": "application/json", ...cors(req) })
      .end(JSON.stringify({ error }));
  };

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname !== EVENTS_PATH && url.pathname !== SAVE_PATH) return false;

    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          ...cors(req),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        })
        .end();
      return true;
    }

    // The startup-minted token is the only gate: a view is served by the host
    // at an origin we can't predict (a hash subdomain, an ephemeral port), so
    // there is nothing to compare an Origin header against. The token is a
    // UUID that never leaves this process except inside the widget we serve.
    if (url.searchParams.get("token") !== token) {
      log.warn("rejected widget request with a bad token", { path: url.pathname });
      deny(req, res, 403, "forbidden");
      return true;
    }
    const sessionId = url.searchParams.get("session") ?? "";
    const viewId = url.searchParams.get("view") ?? "";
    if (!sessionId || !viewId) {
      deny(req, res, 400, "session and view are required");
      return true;
    }

    if (url.pathname === EVENTS_PATH) openStream(req, res, sessionId, viewId);
    else if (req.method === "POST") acceptSave(req, res, sessionId, viewId);
    else deny(req, res, 405, "method not allowed");
    return true;
  };

  function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    viewId: string,
  ): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...cors(req),
    });
    // Node closes idle sockets by default; an attached view can be quiet for
    // hours.
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.flushHeaders?.();

    const send = (message: ViewMessage) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    const view: SessionView = { id: viewId, sessionId, send, close: () => res.end() };

    const record = store.get(sessionId);
    if (!record) {
      // Don't attach: nothing will ever arrive for a session that isn't there.
      send({ type: "session-gone" });
      res.end();
      return;
    }

    const detach = views.attach(view);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref?.();
    const cleanUp = () => {
      clearInterval(heartbeat);
      detach();
    };
    res.on("close", cleanUp);
    res.on("error", cleanUp);

    // Hydrate immediately: the bridge's initialProjects is waiting on this.
    send({ type: "project", version: record.version, files: { ...record.files } });
  }

  function acceptSave(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    viewId: string,
  ): void {
    readJsonBody(req, MAX_SAVE_BYTES)
      .then((body) => {
        const files = (body as { files?: unknown } | null)?.files;
        if (!isFileMap(files)) {
          deny(req, res, 400, "files must be an object of file name to contents");
          return;
        }
        if (!store.has(sessionId)) {
          // Racing a session_end or the idle reaper. The edit has nowhere to
          // go; the view finds out from its own session-gone event.
          deny(req, res, 404, "unknown session");
          return;
        }
        const previous = store.get(sessionId)!.version;
        const base = (body as { baseVersion?: unknown }).baseVersion;
        if (typeof base === "number" && base !== previous) {
          // Last write wins. The user is asking the assistant to edit on their
          // behalf, so we don't try to merge; we just say what happened.
          log.warn("view save is based on an older version", {
            session_id: sessionId,
            view: viewId,
            baseVersion: base,
            currentVersion: previous,
          });
        }
        const record = store.commit(sessionId, files, viewId);
        log.info("view save committed", {
          session_id: sessionId,
          view: viewId,
          version: record.version,
          code: preview(files["main.ts"] ?? ""),
        });
        res.writeHead(200, { "content-type": "application/json", ...cors(req) }).end(
          JSON.stringify({ ok: true, version: record.version }),
        );
      })
      .catch((err: Error & { code?: string }) => {
        if (err.code === "TOO_LARGE") deny(req, res, 413, "body too large");
        else deny(req, res, 400, "invalid body");
      });
  }

  return {
    handle,
    close() {
      unsubscribe();
      views.closeEverything();
    },
  };
}

function isFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Keep draining but stop accumulating: destroying the request here
        // would reach the client as a connection reset instead of our 413.
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}
