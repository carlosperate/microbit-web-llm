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
  // Persistent editor tab shared by all `*_from_code` calls. Loaded once at
  // startup (loading MakeCode can take many seconds on cold cache / slow
  // network, so reopening per-call is a non-starter) and reused thereafter.
  private statelessPagePromise: Promise<PageLike> | null = null;
  // Chained promise mutex serialising access to the stateless tab — the
  // editor only holds one project at a time, so concurrent `*_from_code`
  // calls would race on import/compile.
  private statelessLock: Promise<unknown> = Promise.resolve();

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

  private statelessPage(): Promise<PageLike> {
    if (!this.statelessPagePromise) {
      const p = (async () => {
        const [shell, page] = await Promise.all([
          this.shell(),
          this.renderPool.openPage(),
        ]);
        await page.goto(shell.url, { waitUntil: "domcontentloaded" });
        // Block until the embedded editor finishes loading — `__mkcp.ready()`
        // resolves on `onEditorContentLoaded`. Without this the first stateless
        // call would itself trigger and wait for MakeCode to load.
        const endReady = log.time("stateless tab: MakeCode editor ready");
        try {
          await page.evaluate(`window.__mkcp.ready()`);
        } finally {
          endReady();
        }
        return page;
      })().catch((err) => {
        if (this.statelessPagePromise === p) this.statelessPagePromise = null;
        throw err;
      });
      this.statelessPagePromise = p;
    }
    return this.statelessPagePromise;
  }

  /**
   * Kick off stateless-tab loading without awaiting. Called at MCP startup so
   * the editor (which can take minutes on cold cache / slow connection) has
   * the maximum window to finish loading before the first `*_from_code` call.
   */
  prewarm(): void {
    this.statelessPage().catch(() => {
      // Swallow — next call to statelessPage() will see the cleared promise
      // and retry.
    });
  }

  async openTab(opts?: OpenTabOptions): Promise<TabHandle> {
    const page = await this.openSessionShellPage(opts);
    const endReady = log.time("session tab: MakeCode editor ready");
    try {
      await page.evaluate(`window.__mkcp.ready()`);
    } finally {
      endReady();
    }
    const driver: MakeCodeDriver = new PuppeteerDriver(page);
    return {
      driver,
      close: () => page.close().catch(() => {}),
    };
  }

  async withStatelessTab<T>(
    fn: (driver: MakeCodeDriver) => Promise<T>,
  ): Promise<T> {
    // Chain onto the lock so concurrent calls serialise. We capture the
    // previous tail, install a new one, then wait for the previous tail to
    // settle before running our turn. The `finally` releases the new tail
    // regardless of fn's outcome so an error in one call doesn't deadlock the
    // chain.
    const previous = this.statelessLock;
    let release!: () => void;
    this.statelessLock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await previous.catch(() => {});
      const page = await this.statelessPage();
      return await fn(new PuppeteerDriver(page));
    } finally {
      release();
    }
  }

  async dispose(): Promise<void> {
    const shell = this.shellPromise;
    const statelessPage = this.statelessPagePromise;
    this.shellPromise = null;
    this.statelessPagePromise = null;
    if (statelessPage) await statelessPage.then((p) => p.close()).catch(() => {});
    await this.renderPool.dispose();
    await this.sessionPool.dispose();
    if (shell) await (await shell).close().catch(() => {});
  }
}
