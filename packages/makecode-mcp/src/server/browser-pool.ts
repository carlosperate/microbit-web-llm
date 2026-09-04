import { createLogger } from "../shared/logger.js";

const log = createLogger("browser-pool");

export interface PageLike {
  close(): Promise<void>;
  goto(url: string, options?: unknown): Promise<unknown>;
  evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
  url?(): string;
  /**
   * MakeCode TS compile diagnostics seen on this page within the last
   * `withinMs`, or `[]` if none. Optional: only the real Puppeteer page
   * provides it; test doubles and browser-shaped pages omit it.
   */
  recentDiagnostics?(withinMs: number): string[];
}

export interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
  pages?(): Promise<PageLike[]>;
  openWindow?(url: string): Promise<PageLike>;
  /**
   * Optional disconnect hook. The pool registers a listener so a dead browser
   * is evicted proactively, instead of lingering in `this.browser` until the
   * next `isConnected()` check at call time. Without this, two concurrent
   * in-flight callers can both observe a half-dead browser before one of them
   * triggers eviction; with it, the disconnect event nulls the cached
   * reference immediately.
   */
  onDisconnected?(listener: () => void): void;
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
        // Identity-guarded so a late disconnect from a *previous* browser
        // can't null out a freshly-launched replacement.
        b.onDisconnected?.(() => {
          if (this.browser === b) {
            log.warn("browser disconnected — evicting cached instance");
            this.browser = null;
          }
        });
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
    return (await this.claimStartupPage(browser)) ?? (await browser.newPage());
  }

  /** The blank page Chromium opens on launch, once, or null thereafter. */
  private async claimStartupPage(browser: BrowserLike): Promise<PageLike | null> {
    if (this.firstOpenDone) return null;
    this.firstOpenDone = true;
    if (!browser.pages) return null;
    const existing = await browser.pages();
    if (existing.length !== 1) return null;
    const only = existing[0]!;
    const url = only.url?.();
    return url === "about:blank" || url === "" ? only : null;
  }

  async openWindow(url: string): Promise<PageLike> {
    const browser = await this.ensureBrowser();
    // Chrome's startup window is already a real OS window, so take it rather
    // than opening a second and closing this one: headed mode showed a window
    // appear, another appear, then the first vanish.
    const startup = await this.claimStartupPage(browser);
    if (startup) {
      await startup.goto(url, { waitUntil: "domcontentloaded" });
      return startup;
    }
    if (browser.openWindow) return await browser.openWindow(url);
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
