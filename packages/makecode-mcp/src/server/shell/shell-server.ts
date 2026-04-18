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
const SHELL_HTML = resolve(SHELL_SRC, "shell.html");

let bundledShim: string | null = null;
async function getBundledShim(): Promise<string> {
  if (bundledShim) return bundledShim;
  const result = await esbuild.build({
    entryPoints: [SHIM_ENTRY],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    write: false,
    sourcemap: "inline",
  });
  bundledShim = result.outputFiles[0].text;
  return bundledShim;
}

export interface ShellServer {
  url: string;
  close(): Promise<void>;
}

export async function startShellServer(): Promise<ShellServer> {
  const html = readFileSync(SHELL_HTML, "utf8");
  const shim = await getBundledShim();
  const routes: Record<string, { body: string; type: string }> = {
    "/": { body: html, type: "text/html; charset=utf-8" },
    "/shell.html": { body: html, type: "text/html; charset=utf-8" },
    "/shim.js": { body: shim, type: "application/javascript; charset=utf-8" },
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
      res({
        url: `http://127.0.0.1:${addr.port}/shell.html`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
