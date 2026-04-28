import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// This module lives in either src/server/shell (dev) or dist/server/shell
// (built). In both cases the package root is three levels up, and the
// browser-side assets always live under src/server/shell in source form.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_SRC = resolve(HERE, "..", "..", "..", "src", "server", "shell");
const SHIM_ENTRY = resolve(SHELL_SRC, "shim.ts");
const RENDER_SHIM_ENTRY = resolve(SHELL_SRC, "render-shim.ts");
const SHELL_HTML = resolve(SHELL_SRC, "shell.html");
const RENDER_HTML = resolve(SHELL_SRC, "render.html");

const bundles = new Map<string, string>();
async function bundle(entry: string): Promise<string> {
  const cached = bundles.get(entry);
  if (cached) return cached;
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    write: false,
    sourcemap: "inline",
  });
  const text = result.outputFiles[0].text;
  bundles.set(entry, text);
  return text;
}

export interface ShellServer {
  url: string;
  renderUrl: string;
  close(): Promise<void>;
}

export async function startShellServer(): Promise<ShellServer> {
  const shellHtml = readFileSync(SHELL_HTML, "utf8");
  const renderHtml = readFileSync(RENDER_HTML, "utf8");
  const [shim, renderShim] = await Promise.all([
    bundle(SHIM_ENTRY),
    bundle(RENDER_SHIM_ENTRY),
  ]);
  const routes: Record<string, { body: string; type: string }> = {
    "/": { body: shellHtml, type: "text/html; charset=utf-8" },
    "/shell.html": { body: shellHtml, type: "text/html; charset=utf-8" },
    "/shim.js": { body: shim, type: "application/javascript; charset=utf-8" },
    "/render.html": { body: renderHtml, type: "text/html; charset=utf-8" },
    "/render-shim.js": {
      body: renderShim,
      type: "application/javascript; charset=utf-8",
    },
  };
  return await new Promise((res) => {
    const server: Server = createServer((req, reply) => {
      const route = routes[req.url ?? "/"];
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
        renderUrl: `${base}/render.html`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
