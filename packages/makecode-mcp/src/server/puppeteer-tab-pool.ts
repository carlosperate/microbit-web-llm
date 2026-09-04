import { createLogger } from "../shared/logger.js";
import type { MakeCodeDriver } from "../browser/driver-port.js";
import type { BrowserPoolLike, PageLike } from "./browser-pool.js";
import { isDeadPageError } from "./page-errors.js";
import { PuppeteerDriver } from "./puppeteer-driver.js";
import type { ShellServer } from "./shell-server.js";
import type { TabPool } from "./tab-pool.js";

const log = createLogger("puppeteer-tab-pool");

export interface PuppeteerTabPoolOptions {
  browserPool: BrowserPoolLike;
  /** Serves the editor shell. Started and closed by the caller, because the
   *  MCP server needs its origin to declare the widget's CSP. */
  shell: ShellServer;
  /** Show the shared editor in a real OS window (`--headed`). */
  headed?: boolean;
}

export class PuppeteerTabPool implements TabPool {
  private readonly browserPool: BrowserPoolLike;
  private readonly shell: ShellServer;
  private readonly headed: boolean;
  // The one editor tab, shared by the `*_from_code` tools and by every session
  // op that needs MakeCode. Loaded once at startup (loading MakeCode can take
  // many seconds on cold cache / slow network, so reopening per-call is a
  // non-starter) and reused thereafter.
  private statelessPagePromise: Promise<PageLike> | null = null;
  // Chained promise mutex serialising access to the tab: the editor only holds
  // one project at a time, so concurrent calls (from different sessions, or
  // from the `*_from_code` tools) would race on import/compile.
  private statelessLock: Promise<unknown> = Promise.resolve();

  constructor(opts: PuppeteerTabPoolOptions) {
    this.browserPool = opts.browserPool;
    this.shell = opts.shell;
    this.headed = opts.headed ?? false;
  }

  private async openEditorPage(url: string): Promise<PageLike> {
    if (this.headed) {
      log.info("headed mode: opening the editor in its own window");
      return this.browserPool.openWindow(url);
    }
    const page = await this.browserPool.openPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }

  private statelessPage(): Promise<PageLike> {
    if (!this.statelessPagePromise) {
      const p = (async () => {
        const page = await this.openEditorPage(this.shell.url);
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
      return await this.runStateless(fn);
    } finally {
      release();
    }
  }

  // Runs fn against the persistent stateless tab, rebuilding it once if the
  // page has died (Chrome discarded/froze the idle tab, renderer recycled,
  // OOPIF re-attached). The stateless path is pure (fn re-imports its code and
  // re-renders), so the retry is fully transparent. Bounded to one retry so a
  // genuinely broken environment fails fast instead of looping. Safe under the
  // chained-promise mutex: only one runStateless runs at a time.
  private async runStateless<T>(
    fn: (driver: MakeCodeDriver) => Promise<T>,
  ): Promise<T> {
    const page = await this.statelessPage();
    try {
      return await fn(new PuppeteerDriver(page));
    } catch (err) {
      if (!isDeadPageError(err)) throw err;
      log.warn("stateless tab died, rebuilding and retrying once", {
        error: String(err),
      });
      this.statelessPagePromise = null;
      await page.close().catch(() => {});
      const fresh = await this.statelessPage();
      return fn(new PuppeteerDriver(fresh));
    }
  }

  async dispose(): Promise<void> {
    const statelessPage = this.statelessPagePromise;
    this.statelessPagePromise = null;
    if (statelessPage) await statelessPage.then((p) => p.close()).catch(() => {});
    await this.browserPool.dispose();
  }
}
