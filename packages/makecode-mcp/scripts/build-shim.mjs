#!/usr/bin/env node
// Prebuild the browser-side shell artifacts that shell-server.ts serves:
//   src/shell/shim.ts   → dist/shell/shim.js  (esbuild bundle, ESM, browser)
//   src/shell/shell.html → dist/shell/shell.html  (copy)
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
