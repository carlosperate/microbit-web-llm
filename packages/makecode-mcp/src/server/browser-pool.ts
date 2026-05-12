export interface PageLike {
  close(): Promise<void>;
  goto(url: string, options?: unknown): Promise<unknown>;
  evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
  url?(): string;
}

export interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
  pages?(): Promise<PageLike[]>;
  openWindow?(url: string): Promise<PageLike>;
}

export type BrowserLauncher = () => Promise<BrowserLike>;

export interface BrowserPoolLike {
  openPage(): Promise<PageLike>;
  openWindow(url: string): Promise<PageLike>;
  dispose(): Promise<void>;
}

export class BrowserPool implements BrowserPoolLike {
  private browser: BrowserLike | null = null;
  private launching: Promise<BrowserLike> | null = null;
  private firstOpenDone = false;

  constructor(private readonly launcher: BrowserLauncher) {}

  private async ensureBrowser(): Promise<BrowserLike> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.browser = null;
    const launching = this.launcher().then(
      (b) => {
        this.browser = b;
        if (this.launching === launching) this.launching = null;
        return b;
      },
      (err) => {
        if (this.launching === launching) this.launching = null;
        throw err;
      },
    );
    this.launching = launching;
    return launching;
  }

  async openPage(): Promise<PageLike> {
    const browser = await this.ensureBrowser();
    // On the very first openPage after a fresh launch, reuse the initial
    // about:blank tab Puppeteer/Chromium always opens — otherwise headed mode
    // shows a leftover blank window next to the real session.
    if (!this.firstOpenDone && browser.pages) {
      this.firstOpenDone = true;
      const existing = await browser.pages();
      const blank = existing.find(
        (p) => p.url?.() === "about:blank" || p.url?.() === "",
      );
      if (blank && existing.length === 1) return blank;
    } else {
      this.firstOpenDone = true;
    }
    return browser.newPage();
  }

  async openWindow(url: string): Promise<PageLike> {
    const browser = await this.ensureBrowser();
    if (browser.openWindow) {
      const page = await browser.openWindow(url);
      // After the new window exists, retire any leftover startup about:blank
      // pages so the user doesn't see a stray blank window next to sessions.
      if (!this.firstOpenDone && browser.pages) {
        this.firstOpenDone = true;
        const existing = await browser.pages();
        for (const p of existing) {
          if (p === page) continue;
          const u = p.url?.();
          if (u === "about:blank" || u === "") {
            await p.close().catch(() => {});
          }
        }
      } else {
        this.firstOpenDone = true;
      }
      return page;
    }
    // Fallback: no native new-window support — open a tab and navigate.
    const page = await this.openPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }

  async withTab<T>(fn: (page: PageLike) => Promise<T>): Promise<T> {
    const page = await this.openPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.launching = null;
    this.firstOpenDone = false;
    if (b) await b.close();
  }
}
