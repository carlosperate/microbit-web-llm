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
  waitForTarget(
    predicate: (t: TargetLike) => boolean,
    options?: { timeout?: number },
  ): Promise<TargetLike>;
}

interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  detach?(): Promise<void>;
}

interface TargetLike {
  _targetId?: string;
  page(): Promise<PageLike | null>;
}

export function adaptPuppeteerBrowser(browser: PuppeteerLikeBrowser): BrowserLike {
  return {
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    newPage: () => browser.newPage(),
    pages: () => browser.pages(),
    async openWindow(url: string): Promise<PageLike> {
      const cdp = await browser.target().createCDPSession();
      try {
        const result = (await cdp.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
        })) as { targetId: string };
        const { targetId } = result;
        const target = await browser.waitForTarget(
          (t) => t._targetId === targetId,
        );
        const page = await target.page();
        if (!page) throw new Error("openWindow: target has no page");
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return page;
      } finally {
        await cdp.detach?.().catch(() => {});
      }
    },
  };
}
