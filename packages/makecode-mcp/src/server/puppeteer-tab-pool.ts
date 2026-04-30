import type { MakeCodeDriver } from "../browser/driver-port.js";
import { BrowserPool, type BrowserLauncher, type PageLike } from "./browser-pool.js";
import { PuppeteerDriver } from "./puppeteer-driver.js";
import { startShellServer, type ShellServer } from "./shell/shell-server.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

export class PuppeteerTabPool implements TabPool {
  private readonly browser: BrowserPool;
  private shellPromise: Promise<ShellServer> | null = null;
  private renderPagePromise: Promise<PageLike> | null = null;

  constructor(launcher: BrowserLauncher) {
    this.browser = new BrowserPool(launcher);
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

  private async openShellPage(): Promise<PageLike> {
    const [shell, page] = await Promise.all([
      this.shell(),
      this.browser.openPage(),
    ]);
    await page.goto(shell.url, { waitUntil: "domcontentloaded" });
    return page;
  }

  private renderPage(): Promise<PageLike> {
    if (!this.renderPagePromise) {
      const p = (async () => {
        const [shell, page] = await Promise.all([
          this.shell(),
          this.browser.openPage(),
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

  async openTab(): Promise<TabHandle> {
    const page = await this.openShellPage();
    const driver: MakeCodeDriver = new PuppeteerDriver(page);
    return {
      driver,
      close: () => page.close().catch(() => {}),
    };
  }

  async withTransientTab<T>(
    fn: (driver: MakeCodeDriver) => Promise<T>,
  ): Promise<T> {
    const page = await this.openShellPage();
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
    await this.browser.dispose();
    if (shell) await (await shell).close().catch(() => {});
  }
}
