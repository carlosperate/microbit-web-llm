import type { MakeCodeDriver } from "../browser/driver-port.js";
import { BrowserPool, type BrowserLauncher, type PageLike } from "./browser-pool.js";
import { PuppeteerDriver } from "./puppeteer-driver.js";
import { startShellServer, type ShellServer } from "./shell/shell-server.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

export class PuppeteerTabPool implements TabPool {
  private readonly browser: BrowserPool;
  private shellPromise: Promise<ShellServer> | null = null;

  constructor(launcher: BrowserLauncher) {
    this.browser = new BrowserPool(launcher);
  }

  private shell(): Promise<ShellServer> {
    if (!this.shellPromise) this.shellPromise = startShellServer();
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

  async dispose(): Promise<void> {
    const shell = this.shellPromise;
    this.shellPromise = null;
    await this.browser.dispose();
    if (shell) await (await shell).close().catch(() => {});
  }
}
