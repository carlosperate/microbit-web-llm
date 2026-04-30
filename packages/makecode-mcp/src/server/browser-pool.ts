export interface PageLike {
  close(): Promise<void>;
  goto(url: string, options?: unknown): Promise<unknown>;
  evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
}

export interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
}

export type BrowserLauncher = () => Promise<BrowserLike>;

export class BrowserPool {
  private browser: BrowserLike | null = null;
  private launching: Promise<BrowserLike> | null = null;

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
    return browser.newPage();
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
    if (b) await b.close();
  }
}
