import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { Launcher } from "chrome-launcher";
import { BrowserPool } from "../../src/server/browser-pool.ts";
import { resolveChromePath } from "../../src/server/chrome-path.ts";
import { adaptPuppeteerBrowser } from "../../src/server/puppeteer-browser-adapter.ts";
import { PuppeteerTabPool } from "../../src/server/puppeteer-tab-pool.ts";
import { SessionExecutor } from "../../src/server/session-executor.ts";
import { SessionStore } from "../../src/server/session-store.ts";
import { ViewRegistry } from "../../src/server/view-registry.ts";
// Built shell-server: it resolves the shell assets relative to its own module,
// so the prebuilt dist/shell/* are only found from dist.
import { startShellServer, type ShellServer } from "../../dist/server/shell-server.js";

// End-to-end proof of the Phase 2 widget bridge against real MakeCode, driving
// the real stack: a tool writes code through SessionExecutor, and a widget view
// attached over SSE shows it in a live editor and reports its own editor's save
// back. The only hop this can't cover is the host-side one (Claude Desktop
// framing our localhost origin).
// Launches Chrome + loads makecode.microbit.org twice, so it's opt-in:
//   MKCP_PUPPETEER_IT=1 npx vitest run test/server/widget-bridge.puppeteer.test.ts
const run = process.env.MKCP_PUPPETEER_IT ? describe : describe.skip;

const CODE = 'basic.showString("bridge")\n';

async function until<T>(
  what: string,
  probe: () => Promise<T | null> | (T | null),
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

run("widget bridge syncs a live session", () => {
  let browser: Browser;
  let shell: ShellServer;
  let store: SessionStore;
  let views: ViewRegistry;
  let executor: SessionExecutor;
  let page: Page;

  beforeAll(async () => {
    const executablePath = resolveChromePath({
      env: process.env,
      findSystemChrome: () => Launcher.getFirstInstallation(),
    });
    browser = await puppeteer.launch({ headless: true, executablePath });
    store = new SessionStore();
    views = new ViewRegistry();
    shell = await startShellServer({ store, views });
    const pool = new PuppeteerTabPool({
      browserPool: new BrowserPool(async () => adaptPuppeteerBrowser(browser as never)),
      shell,
    });
    executor = new SessionExecutor(pool, { store, reapIntervalMs: 0 });
  }, 60_000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await browser?.close();
    await shell?.close();
  });

  it("shows a session's code live and reports its own editor's save back", async () => {
    const { session_id } = await executor.startSession({ label: "bridge test" });
    const changes: { version: number; source?: string; code: string }[] = [];
    store.subscribe((c) => {
      if (c.type === "committed" && c.record) {
        changes.push({
          version: c.record.version,
          ...(c.source !== undefined ? { source: c.source } : {}),
          code: c.record.files["main.ts"] ?? "",
        });
      }
    });

    page = await browser.newPage();
    await page.goto(`${shell.bridgeUrl}&session=${session_id}`, {
      waitUntil: "domcontentloaded",
    });

    // The stream opens well before MakeCode is ready.
    await until("the view to attach", () => views.countFor(session_id) === 1 || null, 30_000);
    await page.evaluate("window.__mkcpBridge.ready()");

    // Up: having taken the session's project, the view reads its editor back
    // and reports what it really ended up with, so the server's copy tracks
    // the editor instead of drifting from it.
    const fromView = await until("a save sourced from the view", () =>
      changes.find((c) => c.source !== undefined) ?? null,
    );
    // Nothing has written code yet, so the view must not have invented any.
    expect(fromView.code.trim()).toBe("");

    // Down: a tool call writes code and the live editor picks it up, with no
    // tool ever talking to the view.
    await executor.setCode(session_id, CODE);
    const shown = await until("the editor to show the tool's code", async () => {
      const project = (await page.evaluate("window.__mkcpBridge.project()")) as Record<
        string,
        string
      >;
      return project["main.ts"].includes("bridge") ? project : null;
    });
    // Real blocks, decompiled from the TypeScript, not the empty stub.
    expect(shown["main.blocks"]).toMatch(/<block[\s>]/);
    expect(shown["main.blocks"]).toContain("bridge");
    // And the session still reads back correctly through the tool surface.
    await expect(executor.getCurrentCode(session_id)).resolves.toContain("bridge");
    // The view never invents code: every committed version either came from a
    // tool or carries the code a tool put there.
    for (const c of changes) {
      if (c.source !== undefined && c.code.trim() !== "") {
        expect(c.code).toContain("bridge");
      }
    }

    // Closing the view detaches it; the session itself is untouched.
    await page.close();
    await until("the view to detach", () => views.countFor(session_id) === 0 || null, 30_000);
    expect(store.has(session_id)).toBe(true);
  }, 240_000);

  it("loads inside a sandboxed opaque-origin frame, the way a host embeds it", async () => {
    // The shape every MCP Apps host uses: our bridge nested inside a widget
    // frame whose origin is opaque. A `frame-ancestors` header on the bridge
    // silently breaks exactly this case and nothing else, so the top-level
    // load above cannot catch it.
    const { session_id: sessionId } = await executor.startSession({ label: "sandbox" });
    const page = await browser.newPage();
    try {
      await page.goto(shell.url);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });
      const loaded = await page.evaluate(async (bridgeUrl: string) => {
        return await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve("SILENT"), 15_000);
          addEventListener("message", (e) => {
            if (e.data === "BRIDGE-OK") {
              clearTimeout(timer);
              resolve("LOADED");
            }
          });
          const widget = document.createElement("iframe");
          widget.setAttribute("sandbox", "allow-scripts");
          widget.srcdoc =
            "<script>" +
            'addEventListener("message",function(e){' +
            'if(e.data&&e.data.type==="mkcp-bridge-loaded")parent.postMessage("BRIDGE-OK","*")});' +
            'var f=document.createElement("iframe");f.src=' +
            JSON.stringify(bridgeUrl) +
            ";document.documentElement.appendChild(f);" +
            "<" +
            "/script>";
          document.documentElement.appendChild(widget);
        });
      }, `${shell.bridgeUrl}&session=${sessionId}`);
      expect(loaded, errors.join("\n")).toBe("LOADED");

      // Loading is not enough: the shim has to survive the opaque origin and
      // open its stream. A module that throws at import leaves exactly this
      // trace — widget-shim.js fetched, then no view ever attaches.
      const attached = await until(
        "the sandboxed view to attach",
        () => views.countFor(sessionId) > 0 || null,
        30_000,
      ).catch(() => false);
      expect(attached, `no view attached. frame errors:\n${errors.join("\n")}`).toBe(true);
    } finally {
      await page.close();
    }
  }, 120_000);
});
