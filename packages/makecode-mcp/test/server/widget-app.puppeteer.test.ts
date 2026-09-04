import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { Launcher } from "chrome-launcher";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserPool } from "../../src/server/browser-pool.ts";
import { resolveChromePath } from "../../src/server/chrome-path.ts";
import { adaptPuppeteerBrowser } from "../../src/server/puppeteer-browser-adapter.ts";
import { PuppeteerTabPool } from "../../src/server/puppeteer-tab-pool.ts";
import { SessionExecutor } from "../../src/server/session-executor.ts";
import { SessionStore } from "../../src/server/session-store.ts";
import { ViewRegistry } from "../../src/server/view-registry.ts";
import { buildMcpServer } from "../../src/server/mcp-server.ts";
// Built shell-server: it resolves the shell assets relative to its own module.
import { startShellServer, type ShellServer } from "../../dist/server/shell-server.js";

// The whole widget, as a host actually renders it: served from a *different*
// origin than our server, under the CSP Claude enforces, inside an iframe whose
// parent speaks the MCP Apps handshake. This is the only test that exercises
// the blob-hosted editor, which is the thing every host restriction bears on.
//   MKCP_PUPPETEER_IT=1 npx vitest run test/server/widget-app.puppeteer.test.ts
const run = process.env.MKCP_PUPPETEER_IT ? describe : describe.skip;

const MK = "https://makecode.microbit.org";
const CDN = "https://cdn.makecode.com";
const SIM = "https://trg-microbit.userpxt.io";

/** Claude's enforced policy, plus the origins we declare via _meta.ui.csp. */
const claudeCsp = (self: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${MK} ${CDN} ${SIM}`,
    `style-src 'self' 'unsafe-inline' ${MK} ${CDN} ${SIM}`,
    `img-src 'self' data: blob: ${MK} ${CDN} ${SIM}`,
    `connect-src 'self' blob: data: ${self} ${MK} ${CDN} ${SIM}`,
    `font-src 'self' data: ${MK} ${CDN} ${SIM}`,
    `media-src 'self' blob: data: ${MK} ${CDN} ${SIM}`,
    "worker-src 'self' blob:",
    // The point of the design: no third-party frames, only blob:.
    "frame-src 'self' blob: data:",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

async function until<T>(what: string, probe: () => Promise<T | null> | (T | null), ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

run("the MCP App widget hosts a live editor", () => {
  let browser: Browser;
  let shell: ShellServer;
  let store: SessionStore;
  let views: ViewRegistry;
  let executor: SessionExecutor;
  let hostServer: Server;
  let hostOrigin: string;

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

    // Ask the real MCP server for the widget, so the resource we render is
    // exactly what a host would receive.
    const server = buildMcpServer({
      executor,
      editorBridge: { origin: shell.origin, token: shell.token },
    });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    const widgetHtml = (read.contents[0] as { text: string }).text;
    await client.close();

    hostServer = createServer((req, res) => {
      if (req.url?.startsWith("/widget")) {
        res
          .writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": claudeCsp(shell.origin),
          })
          .end(widgetHtml);
        return;
      }
      // The host page: answers ui/initialize, then delivers the tool result.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<body style="margin:0">
<iframe id="w" src="/widget" style="width:1280px;height:800px;border:0"></iframe>
<script>
  window.__sessionId = new URLSearchParams(location.search).get("session");
  const frame = document.getElementById("w");
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/initialize") {
      frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: "2026-01-26",
        hostCapabilities: { sandbox: { csp: {} } },
        hostInfo: { name: "test-host", version: "1" },
      } }, "*");
    }
    if (m.method === "ui/notifications/initialized" && window.__sessionId) {
      frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: JSON.stringify({ session_id: window.__sessionId }) }] } }, "*");
    }
  });
  window.__deliver = (id) => {
    window.__sessionId = id;
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { content: [{ type: "text", text: JSON.stringify({ session_id: id }) }] } }, "*");
  };
</script>`);
    });
    await new Promise<void>((r) => hostServer.listen(0, "127.0.0.1", () => r()));
    const addr = hostServer.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    hostOrigin = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shell?.close();
    await new Promise<void>((r) => hostServer?.close(() => r()));
  });

  it("shows the session's blocks and reports a user's edit back", async () => {
    const { session_id } = await executor.startSession({ label: "widget-app" });
    await executor.setCode(session_id, 'basic.showString("widget")\n');

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const logs: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.text().includes("mkcp")) logs.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message.slice(0, 200)}`));
    await page.goto(`${hostOrigin}/?session=${encodeURIComponent(session_id)}`, {
      waitUntil: "domcontentloaded",
    });

    // The view attaches over SSE from the widget's own origin.
    await until("the view to attach", () => views.countFor(session_id) > 0 || null, 60_000).catch(
      (err: Error) => {
        throw new Error(`${err.message}\nwidget logs:\n${[...new Set(logs)].join("\n")}`);
      },
    );

    // MakeCode itself has to boot inside the blob frame and render the code.
    const blocks = await until(
      "blocks to render in the blob-hosted editor",
      async () => {
        const mk = page.frames().find((f) => f.url().startsWith("blob:"));
        if (!mk) return null;
        const n = await mk
          .evaluate(() => document.querySelectorAll(".blocklyDraggable").length)
          .catch(() => 0);
        return n > 0 ? n : null;
      },
      120_000,
    );
    expect(blocks).toBeGreaterThan(0);

    // And the editor holds the code the tool wrote, decompiled to blocks.
    const shown = await until(
      "the editor to hold the tool's code",
      async () => {
        const widget = page.frames().find((f) => f.url().includes("/widget"));
        const text = await widget
          ?.evaluate(async () => await window.__mkcpWidget.project())
          .catch(() => null);
        return text && text["main.ts"]?.includes("widget") ? text : null;
      },
      120_000,
    );
    expect(shown!["main.blocks"]).toMatch(/<block[\s>]/);

    // And the other direction: a real drag in the editor has to reach the
    // store, through two nested frames and back over HTTP.
    const before = store.get(session_id)!.version;
    const point = await page.evaluate(() => {
      // host page -> widget iframe -> blob iframe -> element, all same-origin
      // from the widget down, so the offsets can be summed directly.
      const widget = document.getElementById("w") as HTMLIFrameElement;
      const wr = widget.getBoundingClientRect();
      const wdoc = widget.contentDocument!;
      const mk = wdoc.getElementById("mk") as HTMLIFrameElement;
      const mr = mk.getBoundingClientRect();
      const doc = mk.contentDocument!;
      const category = [...doc.querySelectorAll(".blocklyTreeRow, .blocklyToolboxCategory")].find(
        (e) => /Basic/i.test(e.textContent ?? ""),
      );
      if (!category) return null;
      const cr = category.getBoundingClientRect();
      return { x: wr.x + mr.x + cr.x + cr.width / 2, y: wr.y + mr.y + cr.y + cr.height / 2 };
    });
    expect(point, "toolbox category not found").not.toBeNull();
    await page.mouse.click(point!.x, point!.y);

    const blockPoint = await until("a flyout block", async () =>
      page.evaluate(() => {
        const widget = document.getElementById("w") as HTMLIFrameElement;
        const wr = widget.getBoundingClientRect();
        const mk = widget.contentDocument!.getElementById("mk") as HTMLIFrameElement;
        const mr = mk.getBoundingClientRect();
        const blocks = [...mk.contentDocument!.querySelectorAll(".blocklyFlyout .blocklyDraggable")];
        const el = blocks[1] ?? blocks[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: wr.x + mr.x + r.x + r.width / 2, y: wr.y + mr.y + r.y + r.height / 2 };
      }),
    );
    await page.mouse.move(blockPoint.x, blockPoint.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(blockPoint.x + (420 * i) / 10, blockPoint.y + (140 * i) / 10);
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.mouse.up();

    await until(
      "the user's drag to reach the store",
      () => (store.get(session_id)!.version > before ? true : null),
      60_000,
    );
    expect(store.get(session_id)!.files["main.blocks"]).toMatch(/<block[\s>]/);

    await page.close();
  }, 300_000);
});

declare global {
  interface Window {
    __deliver(id: string): void;
    __mkcpWidget: { project(): Promise<Record<string, string>> };
  }
}
