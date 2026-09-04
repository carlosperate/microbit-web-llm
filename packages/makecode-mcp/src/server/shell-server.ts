import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../shared/logger.js";
import type { SessionStore } from "./session-store.js";
import type { ViewRegistry } from "./view-registry.js";
import { createWidgetChannel, type WidgetChannel } from "./widget-channel.js";
import { MakeCodeMirror } from "./makecode-mirror.js";

// Compiled to dist/server/shell-server.js. The browser-side artifacts are
// prebuilt by scripts/build-shim.mjs into dist/shell/ — sibling to the
// compiled server dir.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = resolve(HERE, "..", "shell");
const log = createLogger("shell-server");

// Nothing else is restricted (no default-src), so this only states the one
// thing the bridge page needs and can't get by default if a host applies
// embedded CSP enforcement to the iframe it puts us in.
//
// Deliberately no `frame-ancestors`: an MCP Apps widget runs at an opaque
// origin, which no source expression matches, `*` included (it covers network
// schemes only). Declaring it at all made every host refuse to render us. The
// token, not this header, is what keeps other pages out.
export const BRIDGE_CSP = "frame-src https://makecode.microbit.org";

export interface ShellServerOptions {
  /** Canonical session state the widget views attach to. */
  store: SessionStore;
  views: ViewRegistry;
}

export interface ShellServer {
  /** The editor shell the Puppeteer tab loads. */
  url: string;
  origin: string;
  /** The bridge page, token included; callers append `&session=<id>`. The MCP
   *  App widget no longer uses it (it hosts MakeCode itself in a blob frame);
   *  this is the URL a top-level view is opened with, such as a headed window
   *  or `widget-bridge.puppeteer.test.ts`. */
  bridgeUrl: string;
  token: string;
  close(): Promise<void>;
}

interface Route {
  body: string;
  type: string;
  headers?: Record<string, string>;
}

export async function startShellServer(opts: ShellServerOptions): Promise<ShellServer> {
  // Read once at startup. If the files are missing the user forgot to run
  // `npm run build` (or `scripts/build-shim.mjs`) — fail loud rather than
  // 404 every tool call.
  const html = (name: string) => ({
    body: readFileSync(resolve(SHELL_DIST, name), "utf8"),
    type: "text/html; charset=utf-8",
  });
  const js = (name: string) => ({
    body: readFileSync(resolve(SHELL_DIST, name), "utf8"),
    type: "application/javascript; charset=utf-8",
  });
  const shell = html("shell.html");
  const routes: Record<string, Route> = {
    "/": shell,
    "/shell.html": shell,
    "/shim.js": js("shim.js"),
    "/widget-bridge.html": {
      ...html("widget-bridge.html"),
      headers: { "content-security-policy": BRIDGE_CSP },
    },
    "/widget-shim.js": js("widget-shim.js"),
  };
  // Anyone who can reach the port could otherwise push code into a session.
  const token = randomUUID();
  const mirror = new MakeCodeMirror();
  const MIRROR_ROUTES: Record<string, "editor" | "simulator" | "worker"> = {
    "/mk/editor.html": "editor",
    "/mk/simulator.html": "simulator",
    "/mk/worker.js": "worker",
  };

  return await new Promise((res) => {
    let channel: WidgetChannel | undefined;
    const server: Server = createServer((req, reply) => {
      // Strip the query string before looking up the route — pages carry
      // params (session, token) that must not affect which file we serve.
      const raw = req.url ?? "/";
      const qIdx = raw.indexOf("?");
      const pathname = qIdx === -1 ? raw : raw.slice(0, qIdx);
      // A widget frame blocked by the host's CSP never reaches us at all, so
      // this line is what separates "not framed" from "framed but broken".
      log.info("request", { method: req.method, path: pathname, origin: req.headers.origin });
      if (channel?.handle(req, reply)) return;

      // MakeCode's own pages, rewritten so the view can host them in a blob
      // iframe. Fetched on demand rather than at startup: a network blip should
      // cost one widget load, not the whole server.
      const mirrored = MIRROR_ROUTES[pathname];
      if (mirrored) {
        mirror
          .get(mirrored)
          .then((asset) => {
            reply
              .writeHead(200, {
                "content-type": asset.type,
                "access-control-allow-origin": req.headers.origin ?? "*",
                vary: "Origin",
              })
              .end(asset.body);
          })
          .catch((err: Error) => {
            log.warn("mirror fetch failed", { asset: mirrored, error: String(err) });
            reply.writeHead(502, { "content-type": "text/plain" }).end("mirror unavailable");
          });
        return;
      }

      const route = routes[pathname];
      if (!route) {
        reply.writeHead(404).end();
        return;
      }
      // A module script fetched from the bridge's opaque origin is a CORS
      // request against us, so without this the shim is fetched and then
      // discarded by the browser before it ever runs.
      reply
        .writeHead(200, {
          "content-type": route.type,
          "access-control-allow-origin": req.headers.origin ?? "*",
          vary: "Origin",
          ...route.headers,
        })
        .end(route.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("server address");
      const origin = `http://127.0.0.1:${addr.port}`;
      channel = createWidgetChannel({
        store: opts.store,
        views: opts.views,
        token,
        origin,
      });
      log.info("shell server listening", { origin });
      res({
        url: `${origin}/shell.html`,
        origin,
        bridgeUrl: `${origin}/widget-bridge.html?token=${encodeURIComponent(token)}`,
        token,
        close: () =>
          new Promise<void>((r) => {
            channel?.close();
            server.close(() => r());
          }),
      });
    });
  });
}
