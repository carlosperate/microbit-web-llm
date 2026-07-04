import type { BrowserLike, PageLike } from "./browser-pool.js";
import { MakeCodeDiagnostics } from "./makecode-diagnostics.js";

// A Puppeteer Page is structurally our PageLike already; we only need its
// `on('console')` to capture the cross-origin editor console.
interface PuppeteerLikePage extends PageLike {
  on?(event: "console", listener: (msg: { text(): string }) => void): unknown;
}

// Minimal subset of the Puppeteer Browser API we depend on. Typed loosely so
// the adapter can be unit-tested with a fake CDP session without dragging
// Puppeteer's type tree into tests.
interface PuppeteerLikeBrowser {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PuppeteerLikePage>;
  pages(): Promise<PuppeteerLikePage[]>;
  target(): { createCDPSession(): Promise<CdpSessionLike> };
  on?(event: "disconnected", listener: () => void): unknown;
}

interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  detach?(): Promise<void>;
}

const OPEN_WINDOW_TIMEOUT_MS = 10_000;
const OPEN_WINDOW_POLL_MS = 25;

export function adaptPuppeteerBrowser(browser: PuppeteerLikeBrowser): BrowserLike {
  // MakeCode logs TS compile errors to the (cross-origin) editor console, which
  // only the Node side can read. Give each page a diagnostics buffer fed by its
  // console and expose it as PageLike.recentDiagnostics. We mutate the page in
  // place (idempotent via the WeakSet) rather than wrapping it, because the pool
  // identifies pages by object identity (see openWindow's set-difference).
  const instrumented = new WeakSet<object>();
  const instrument = (page: PuppeteerLikePage): PuppeteerLikePage => {
    if (instrumented.has(page)) return page;
    instrumented.add(page);
    const diagnostics = new MakeCodeDiagnostics();
    page.on?.("console", (msg) => {
      try {
        diagnostics.ingest(msg.text());
      } catch {
        // A malformed console message must never break page operation.
      }
    });
    page.recentDiagnostics = (withinMs) => diagnostics.recent(withinMs);
    return page;
  };

  return {
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    newPage: async () => instrument(await browser.newPage()),
    pages: async () => (await browser.pages()).map(instrument),
    onDisconnected: (listener) => {
      browser.on?.("disconnected", listener);
    },
    async openWindow(url: string): Promise<PageLike> {
      // CDP `newWindow: true` (not `window.open`) so headed mode gets a real
      // OS window. The new page is found by set-difference against a pre-call
      // `pages()` snapshot — avoids Puppeteer's private `_targetId`.
      const cdp = await browser.target().createCDPSession();
      try {
        const before = new Set(await browser.pages());
        await cdp.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        });
        const deadline = Date.now() + OPEN_WINDOW_TIMEOUT_MS;
        let newPage: PuppeteerLikePage | undefined;
        while (Date.now() < deadline) {
          const current = await browser.pages();
          newPage = current.find((p) => !before.has(p));
          if (newPage) break;
          await new Promise((r) => setTimeout(r, OPEN_WINDOW_POLL_MS));
        }
        if (!newPage) {
          throw new Error(
            `openWindow timed out after ${OPEN_WINDOW_TIMEOUT_MS / 1000}s waiting for the new window to appear`,
          );
        }
        await newPage.goto(url, { waitUntil: "domcontentloaded" });
        return instrument(newPage);
      } finally {
        await cdp.detach?.().catch(() => {});
      }
    },
  };
}
