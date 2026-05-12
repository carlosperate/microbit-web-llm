import { createLogger } from "../shared/logger.js";
import type { MakeCodeDriver } from "../browser/driver-port.js";
import type { BrowserPoolLike, PageLike } from "./browser-pool.js";
import { PuppeteerDriver } from "./puppeteer-driver.js";
import { startShellServer, type ShellServer } from "./shell/shell-server.js";
import type { OpenTabOptions, TabHandle, TabPool } from "./tab-pool.js";

const log = createLogger("puppeteer-tab-pool");

export interface PuppeteerTabPoolOptions {
  renderPool: BrowserPoolLike;
  sessionPool: BrowserPoolLike;
  headed?: boolean;
}

export class PuppeteerTabPool implements TabPool {
  private readonly renderPool: BrowserPoolLike;
  private readonly sessionPool: BrowserPoolLike;
  private readonly headed: boolean;
  private headedLogged = false;
  private shellPromise: Promise<ShellServer> | null = null;
  private renderPagePromise: Promise<PageLike> | null = null;

  constructor(opts: PuppeteerTabPoolOptions) {
    this.renderPool = opts.renderPool;
    this.sessionPool = opts.sessionPool;
    this.headed = opts.headed ?? false;
  }

  private shell(): Promise<ShellServer> {
    if (!this.shellPromise) {
      const p = startShellServer().catch((err) => {
        if (this.shellPromise === p) this.shellPromise = null;
        throw err;
      });
      this.shellPromise = p;
    }
    return this.shellPromise;
  }

  private async openSessionShellPage(opts?: OpenTabOptions): Promise<PageLike> {
    if (this.headed && !this.headedLogged) {
      this.headedLogged = true;
      log.info("session pool: headed mode");
    }
    const shell = await this.shell();
    const url = new URL(shell.url);
    if (opts?.sessionId) url.searchParams.set("session", opts.sessionId);
    if (opts?.label !== undefined) url.searchParams.set("label", opts.label);
    return this.sessionPool.openWindow(url.toString());
  }

  private async openRenderShellPage(): Promise<PageLike> {
    const [shell, page] = await Promise.all([
      this.shell(),
      this.renderPool.openPage(),
    ]);
    await page.goto(shell.url, { waitUntil: "domcontentloaded" });
    return page;
  }

  private renderPage(): Promise<PageLike> {
    if (!this.renderPagePromise) {
      const p = (async () => {
        const [shell, page] = await Promise.all([
          this.shell(),
          this.renderPool.openPage(),
        ]);
        await page.goto(shell.renderUrl, { waitUntil: "domcontentloaded" });
        return page;
      })().catch((err) => {
        if (this.renderPagePromise === p) this.renderPagePromise = null;
        throw err;
      });
      this.renderPagePromise = p;
    }
    return this.renderPagePromise;
  }

  async openTab(opts?: OpenTabOptions): Promise<TabHandle> {
    const page = await this.openSessionShellPage(opts);
    const driver: MakeCodeDriver = new PuppeteerDriver(page);
    return {
      driver,
      close: () => page.close().catch(() => {}),
    };
  }

  async withTransientTab<T>(
    fn: (driver: MakeCodeDriver) => Promise<T>,
  ): Promise<T> {
    const page = await this.openRenderShellPage();
    try {
      return await fn(new PuppeteerDriver(page));
    } finally {
      await page.close().catch(() => {});
    }
  }

  async renderBlocksImage(code: string): Promise<string> {
    const page = await this.renderPage();
    return page.evaluate(
      (c: unknown) =>
        (
          window as unknown as {
            __mkcp_render: { renderBlocksImage(c: unknown): Promise<string> };
          }
        ).__mkcp_render.renderBlocksImage(c),
      code,
    ) as Promise<string>;
  }

  async dispose(): Promise<void> {
    const shell = this.shellPromise;
    const renderPage = this.renderPagePromise;
    this.shellPromise = null;
    this.renderPagePromise = null;
    if (renderPage) await renderPage.then((p) => p.close()).catch(() => {});
    await this.renderPool.dispose();
    await this.sessionPool.dispose();
    if (shell) await (await shell).close().catch(() => {});
  }
}
