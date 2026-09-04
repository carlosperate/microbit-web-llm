#!/usr/bin/env node
// Prebuild the browser-side shell artifacts:
//   src/shell/shim.ts            → dist/shell/shim.js          (esbuild bundle, ESM, browser)
//   src/shell/shell.html         → dist/shell/shell.html       (copy; served by shell-server.ts)
//   src/shell/widget-shim.ts     → dist/shell/widget-shim.js   (esbuild bundle; the widget bridge)
//   src/shell/widget-bridge.html → dist/shell/widget-bridge.html (copy; served by shell-server.ts)
//   src/shell/blocks-viewer.html → dist/shell/blocks-viewer.html (copy; served via MCP
//   src/shell/editor.html        → dist/shell/editor.html         resources/read as ui:// MCP App
//                                                                 widgets: blocks images inline,
//                                                                 and the live session editor)
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

for (const entry of ["shim.ts", "widget-shim.ts", "widget-app.ts"]) {
  // widget-app is inlined into the MCP App resource, so it must be a classic
  // script and carry no inline sourcemap (it would multiply the payload).
  const inlined = entry === "widget-app.ts";
  await build({
    entryPoints: [join(srcShell, entry)],
    outfile: join(distShell, entry.replace(/\.ts$/, ".js")),
    bundle: true,
    format: inlined ? "iife" : "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: inlined ? false : "inline",
    minify: inlined,
    logLevel: "info",
    // The adapter's pre-validation pulls in pxt-mkc, which requires "path".
    alias: { path: "path-browserify" },
  });
}

for (const page of [
  "shell.html",
  "widget-bridge.html",
  "blocks-viewer.html",
  "editor.html",
]) {
  copyFileSync(join(srcShell, page), join(distShell, page));
  console.log(`  copied ${page} → ${join(distShell, page)}`);
}
