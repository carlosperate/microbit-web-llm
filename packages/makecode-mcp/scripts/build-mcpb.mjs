#!/usr/bin/env node
// Build script for the makecode-mcp Claude Desktop extension (.mcpb).
//
// Stages the package into a clean directory, runs `npm install --omit=dev`
// with `PUPPETEER_SKIP_DOWNLOAD=true` (so we don't bundle Chromium), then
// calls `mcpb pack`. The resulting .mcpb is OS-agnostic because Chrome is
// located at runtime via chrome-launcher in bin.ts.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const stagingDir = join(packageRoot, ".mcpb-staging");
const distDir = join(packageRoot, "dist");
const outFile = join(distDir, "makecode-mcp.mcpb");

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: packageRoot, ...opts });
}

function stage(name) {
  const src = join(packageRoot, name);
  const dest = join(stagingDir, name);
  if (!existsSync(src)) {
    throw new Error(`Cannot stage missing file: ${name}`);
  }
  cpSync(src, dest, { recursive: true });
  console.log(`  staged ${name}`);
}

console.log("→ Building TypeScript (forced clean)");
// `tsc -b` is incremental and will skip rebuilding if `tsbuildinfo` looks
// fresh even when `dist/` has been deleted. Force a full rebuild so the
// staged bundle always reflects current source.
run("npx tsc -b --force");

console.log("\n→ Resetting staging dir");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

console.log("\n→ Staging files");
stage("dist");
// shell-server.ts reads src/server/shell/*.html at runtime and bundles the
// browser-side shims (which reach into src/browser/ and src/shared/) via
// esbuild on first request, so the src tree must ship.
stage("src");
stage("manifest.json");
stage("README.md");

// Strip dev-only fields and the private flag so the staged package.json is a
// minimal runtime descriptor. We don't republish it; this just keeps the
// .mcpb tidy and avoids confusing tooling.
const pkg = JSON.parse(
  execSync("cat package.json", { cwd: packageRoot }).toString(),
);
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  bin: pkg.bin,
  dependencies: pkg.dependencies,
};
writeFileSync(
  join(stagingDir, "package.json"),
  JSON.stringify(stagedPkg, null, 2) + "\n",
);
console.log("  wrote trimmed package.json");

console.log("\n→ Installing production dependencies (no Chromium)");
run("npm install --omit=dev --no-audit --no-fund", {
  cwd: stagingDir,
  env: {
    ...process.env,
    PUPPETEER_SKIP_DOWNLOAD: "true",
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true",
  },
});

console.log("\n→ Packing .mcpb");
mkdirSync(distDir, { recursive: true });
run(`npx --yes @anthropic-ai/mcpb pack . "${outFile}"`, { cwd: stagingDir });

console.log(`\n✓ Built ${outFile}`);
