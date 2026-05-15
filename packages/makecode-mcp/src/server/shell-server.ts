import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to dist/server/shell-server.js. The browser-side artifacts are
// prebuilt by scripts/build-shim.mjs into dist/shell/{shim.js, shell.html}
// — sibling to the compiled server dir.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = resolve(HERE, "..", "shell");
const SHIM_JS = resolve(SHELL_DIST, "shim.js");
const SHELL_HTML = resolve(SHELL_DIST, "shell.html");

export interface ShellServer {
  url: string;
  close(): Promise<void>;
}

export async function startShellServer(): Promise<ShellServer> {
  // Read once at startup. If the files are missing the user forgot to run
  // `npm run build` (or `scripts/build-shim.mjs`) — fail loud rather than
  // 404 every tool call.
  const shellHtml = readFileSync(SHELL_HTML, "utf8");
  const shim = readFileSync(SHIM_JS, "utf8");
  const routes: Record<string, { body: string; type: string }> = {
    "/": { body: shellHtml, type: "text/html; charset=utf-8" },
    "/shell.html": { body: shellHtml, type: "text/html; charset=utf-8" },
    "/shim.js": { body: shim, type: "application/javascript; charset=utf-8" },
  };
  return await new Promise((res) => {
    const server: Server = createServer((req, reply) => {
      // Strip the query string before looking up the route — sessions navigate
      // to `/shell.html?session=…&label=…` and the params must not affect
      // which file we serve.
      const raw = req.url ?? "/";
      const qIdx = raw.indexOf("?");
      const pathname = qIdx === -1 ? raw : raw.slice(0, qIdx);
      const route = routes[pathname];
      if (!route) {
        reply.writeHead(404).end();
        return;
      }
      reply.writeHead(200, { "content-type": route.type }).end(route.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("server address");
      const base = `http://127.0.0.1:${addr.port}`;
      res({
        url: `${base}/shell.html`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
