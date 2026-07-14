import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser } from "puppeteer";
import { Launcher } from "chrome-launcher";
import { build, preview, type PreviewServer } from "vite";
import { resolveChromePath } from "../../src/server/chrome-path.ts";

// End-to-end proof the browser-side local compiler downloads the live
// makecode.microbit.org compiler and reproduces the editor's TS diagnostics.
// Uses a production vite build (same bundling path as the app) served by
// vite preview. Real Chrome + network, so it's opt-in:
//   MKCP_PUPPETEER_IT=1 npx vitest run test/browser/local-compiler.puppeteer.test.ts
const run = process.env.MKCP_PUPPETEER_IT ? describe : describe.skip;

// Same bad code as the server-side diagnostics test.
const BAD_CODE = `basic.showString('Happy Face')
input.onButtonPressed(button.A, function () {
    basic.showString('Angry Face')
})
accelermeter.onPeriodicMotion(100, function () {
    basic.showString('Angry Face')
})`;

run("local compiler against the live editor", () => {
  let server: PreviewServer;
  let browser: Browser;
  let url: string;
  let outDir: string;

  beforeAll(async () => {
    const root = fileURLToPath(new URL("../fixtures/local-compiler", import.meta.url));
    outDir = mkdtempSync(join(tmpdir(), "mkcp-local-compiler-"));
    const shared = {
      configFile: false as const,
      root,
      logLevel: "silent" as const,
      // Same alias the app's vite.config.ts needs for makecode-mcp/browser.
      resolve: { alias: { path: "path-browserify" } },
      build: { outDir },
    };
    await build(shared);
    server = await preview({ ...shared, preview: { port: 0 } });
    url = server.resolvedUrls!.local[0]!;
    browser = await puppeteer.launch({
      headless: true,
      executablePath: resolveChromePath({
        env: process.env,
        findSystemChrome: () => Launcher.getFirstInstallation(),
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.httpServer.close(resolve));
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("reports the editor's TS errors with line/column and codes", async () => {
    const page = await browser.newPage();
    // Fail-open means an engine failure shows up as [] here; surface the page
    // console so the gated test stays debuggable.
    const consoleLines: string[] = [];
    page.on("console", (msg) => {
      consoleLines.push(msg.text());
      console.error(`[page:${msg.type()}]`, msg.text());
    });
    page.on("pageerror", (err) => console.error("[pageerror]", err));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const lines = (await page.evaluate(
      `window.__getDiagnostics(${JSON.stringify(BAD_CODE)})`,
    )) as string[];

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^main\.ts\(2,23\): error TS2552: Cannot find name 'button'/);
    expect(lines[1]).toMatch(/^main\.ts\(5,1\): error TS2304: Cannot find name 'accelermeter'/);

    // Console signature: every fetch must be traced with the
    // [mkcp:local-compiler] prefix (host requestAsync log + mkc's setLogging
    // redirect) so DevTools output can't be mistaken for the MakeCode iframe's
    // console. Known exception, asserted here so an upstream fix is noticed:
    // mkc's downloader prints bare "Download <url>" lines through a
    // module-private console.log that setLogging can't reach (pxt-mkc 1.7.9);
    // they appear on cold init only and nest inside our console.group.
    const fetchLines = consoleLines.filter((l) => /GET https?:\/\//.test(l));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) expect(line).toContain("[mkcp:local-compiler]");

    // Warm recompile with clean code succeeds quietly.
    const clean = (await page.evaluate(
      `window.__getDiagnostics("basic.showNumber(1)")`,
    )) as string[];
    expect(clean).toEqual([]);
    await page.close();
  }, 120_000);
});
