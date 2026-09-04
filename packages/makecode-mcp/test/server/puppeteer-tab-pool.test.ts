import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { PuppeteerTabPool } from "../../src/server/puppeteer-tab-pool.ts";
import type {
  BrowserPoolLike,
  PageLike,
} from "../../src/server/browser-pool.ts";

vi.mock("../../src/server/puppeteer-driver.js", () => ({
  PuppeteerDriver: class {
    constructor(public page: unknown) {}
  },
}));

const shellClose = vi.fn(async () => {});
const shell = {
  url: "http://127.0.0.1:0/shell.html",
  origin: "http://127.0.0.1:0",
  bridgeUrl: "http://127.0.0.1:0/widget-bridge.html?token=t",
  token: "t",
  close: shellClose,
};

function makePage(): PageLike & {
  close: MockedFunction<() => Promise<void>>;
  goto: MockedFunction<(u: string, o?: unknown) => Promise<unknown>>;
} {
  return {
    close: vi.fn(async () => {}),
    goto: vi.fn(async () => undefined as unknown),
    evaluate: vi.fn(async () => undefined as unknown),
  } as never;
}

function makePoolDouble(): BrowserPoolLike & {
  openPage: MockedFunction<() => Promise<PageLike>>;
  openWindow: MockedFunction<(url: string) => Promise<PageLike>>;
  dispose: MockedFunction<() => Promise<void>>;
  pages: ReturnType<typeof makePage>[];
} {
  const pages: ReturnType<typeof makePage>[] = [];
  return {
    openPage: vi.fn(async () => {
      const p = makePage();
      pages.push(p);
      return p;
    }),
    openWindow: vi.fn(async (_url: string) => {
      const p = makePage();
      pages.push(p);
      return p;
    }),
    dispose: vi.fn(async () => {}),
    pages,
  } as never;
}

describe("PuppeteerTabPool — the shared editor tab", () => {
  it("prewarm opens the shared editor tab headless by default", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    pool.prewarm();
    await new Promise((r) => setTimeout(r, 0));

    expect(browserPool.openPage).toHaveBeenCalledOnce();
    expect(browserPool.openWindow).not.toHaveBeenCalled();
    expect(browserPool.pages[0].goto).toHaveBeenCalledWith(
      "http://127.0.0.1:0/shell.html",
      expect.anything(),
    );
  });

  it("headed mode opens the shared editor in a real OS window instead", async () => {
    // One window for the whole server: sessions are data, so there is nothing
    // per-session left to show. The user still gets to watch MakeCode work.
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell, headed: true });

    await pool.withStatelessTab(async () => "ok");

    expect(browserPool.openWindow).toHaveBeenCalledWith(
      "http://127.0.0.1:0/shell.html",
    );
    expect(browserPool.openPage).not.toHaveBeenCalled();
  });

  it("the editor tab is opened once and shared by every call, headed or not", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell, headed: true });

    await pool.withStatelessTab(async () => "a");
    await pool.withStatelessTab(async () => "b");

    expect(browserPool.openWindow).toHaveBeenCalledOnce();
  });

  it("prewarm is idempotent — repeated calls reuse the same stateless tab", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    pool.prewarm();
    pool.prewarm();
    await pool.withStatelessTab(async () => "ok");

    expect(browserPool.openPage).toHaveBeenCalledOnce();
  });

  it("prewarm failures do not propagate and a later call retries", async () => {
    const browserPool = makePoolDouble();
    browserPool.openPage.mockRejectedValueOnce(new Error("boom"));
    const pool = new PuppeteerTabPool({ browserPool, shell });

    expect(() => pool.prewarm()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    await pool.withStatelessTab(async () => "ok");
    expect(browserPool.openPage).toHaveBeenCalledTimes(2);
  });

  it("withStatelessTab reuses the same persistent page across calls (no per-call reopen)", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    await pool.withStatelessTab(async () => "a");
    await pool.withStatelessTab(async () => "b");
    await pool.withStatelessTab(async () => "c");

    // One openPage for the persistent tab, reused for every call.
    expect(browserPool.openPage).toHaveBeenCalledOnce();
  });

  it("withStatelessTab serialises concurrent calls so the editor's single-project state can't race", async () => {
    // Two concurrent calls must run sequentially. We verify by latching:
    // the second call must not start until the first releases.
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    const order: string[] = [];
    let release1!: () => void;
    const inflight1 = new Promise<void>((r) => (release1 = r));
    const p1 = pool.withStatelessTab(async () => {
      order.push("1:enter");
      await inflight1;
      order.push("1:exit");
      return "1";
    });
    // Give p1 a microtask to start.
    await Promise.resolve();
    const p2 = pool.withStatelessTab(async () => {
      order.push("2:enter");
      return "2";
    });
    await new Promise((r) => setTimeout(r, 10));
    // p2 must not have entered yet.
    expect(order).toEqual(["1:enter"]);
    release1();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["1:enter", "1:exit", "2:enter"]);
  });

  it("withStatelessTab rebuilds the stateless tab and retries once when the page dies", async () => {
    // Chrome can discard/freeze an idle background tab (or its renderer is
    // recycled), detaching the frame so the next page.evaluate throws. The
    // stateless path is pure, so a transparent rebuild + retry must recover.
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    let calls = 0;
    const result = await pool.withStatelessTab(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("Attempted to use detached Frame '16147B7AF484C3'");
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // Original stateless tab opened, died, replacement opened.
    expect(browserPool.openPage).toHaveBeenCalledTimes(2);
    // The dead page was closed so it doesn't leak.
    expect(browserPool.pages[0].close).toHaveBeenCalledOnce();
  });

  it("withStatelessTab does not retry on a normal (non-dead-page) error", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    let calls = 0;
    await expect(
      pool.withStatelessTab(async () => {
        calls++;
        throw new Error("failed to compile to blocks");
      }),
    ).rejects.toThrow(/failed to compile to blocks/);
    expect(calls).toBe(1);
    expect(browserPool.openPage).toHaveBeenCalledOnce();
  });

  it("withStatelessTab gives up after one retry if the replacement also dies", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    let calls = 0;
    await expect(
      pool.withStatelessTab(async () => {
        calls++;
        throw new Error("Target closed");
      }),
    ).rejects.toThrow(/Target closed/);
    expect(calls).toBe(2);
    expect(browserPool.openPage).toHaveBeenCalledTimes(2);
  });

  it("withStatelessTab still releases the lock if the user fn throws", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    await expect(
      pool.withStatelessTab(async () => {
        throw new Error("user fn fail");
      }),
    ).rejects.toThrow(/user fn fail/);
    // Subsequent call must still proceed (lock was released).
    await expect(pool.withStatelessTab(async () => "ok")).resolves.toBe("ok");
  });

  it("dispose closes the editor tab and disposes the browser pool", async () => {
    const browserPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ browserPool, shell });

    await pool.withStatelessTab(async () => "ok");
    await pool.dispose();

    expect(browserPool.pages[0].close).toHaveBeenCalledOnce();
    expect(browserPool.dispose).toHaveBeenCalledOnce();
    // The shell server outlives the pool: the MCP server serves the widget
    // from it, so bin.ts owns closing it.
    expect(shellClose).not.toHaveBeenCalled();
  });
});
