#!/usr/bin/env node
// Prebuild the browser-side shell artifacts:
//   src/shell/shim.ts            → dist/shell/shim.js          (esbuild bundle, ESM, browser)
//   src/shell/shell.html         → dist/shell/shell.html       (copy; served by shell-server.ts)
//   src/shell/blocks-viewer.html → dist/shell/blocks-viewer.html (copy; served via MCP
//                                                                 resources/read as a ui:// MCP App
//                                                                 widget so Claude Desktop renders
//                                                                 blocks images inline)
//
// Replaces the previous runtime-esbuild-on-first-request path. The .mcpb
// bundle now ships dist/shell/ instead of the whole src/ tree.

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const srcShell = join(packageRoot, "src", "shell");
const distShell = join(packageRoot, "dist", "shell");

mkdirSync(distShell, { recursive: true });

await build({
  entryPoints: [join(srcShell, "shim.ts")],
  outfile: join(distShell, "shim.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: "inline",
  logLevel: "info",
});

copyFileSync(join(srcShell, "shell.html"), join(distShell, "shell.html"));
console.log(`  copied shell.html → ${join(distShell, "shell.html")}`);

copyFileSync(join(srcShell, "blocks-viewer.html"), join(distShell, "blocks-viewer.html"));
console.log(`  copied blocks-viewer.html → ${join(distShell, "blocks-viewer.html")}`);
