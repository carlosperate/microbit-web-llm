import type { BrowserLike, PageLike } from "./browser-pool.js";

// Minimal subset of the Puppeteer Browser API we depend on. Typed loosely so
// the adapter can be unit-tested with a fake CDP session without dragging
// Puppeteer's type tree into tests.
interface PuppeteerLikeBrowser {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
  pages(): Promise<PageLike[]>;
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
  return {
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    newPage: () => browser.newPage(),
    pages: () => browser.pages(),
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
        let newPage: PageLike | undefined;
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
        return newPage;
      } finally {
        await cdp.detach?.().catch(() => {});
      }
    },
  };
}
