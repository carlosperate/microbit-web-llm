import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { BrowserPool } from "../../src/server/browser-pool.ts";
import type {
  BrowserLike,
  BrowserLauncher,
  PageLike,
} from "../../src/server/browser-pool.ts";

function makePageDouble(): PageLike & {
  close: MockedFunction<() => Promise<void>>;
} {
  return {
    close: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined as unknown),
  } as unknown as PageLike & { close: MockedFunction<() => Promise<void>> };
}

function makeBrowserDouble() {
  const pages: Array<ReturnType<typeof makePageDouble>> = [];
  const disconnectListeners: Array<() => void> = [];
  const browser: BrowserLike & {
    isConnected: MockedFunction<() => boolean>;
    close: MockedFunction<() => Promise<void>>;
    newPage: MockedFunction<() => Promise<PageLike>>;
    onDisconnected: MockedFunction<(listener: () => void) => void>;
  } = {
    isConnected: vi.fn(() => true),
    close: vi.fn(async () => {}),
    newPage: vi.fn(async () => {
      const p = makePageDouble();
      pages.push(p);
      return p;
    }),
    onDisconnected: vi.fn((listener: () => void) => {
      disconnectListeners.push(listener);
    }),
  } as never;
  /** Simulate the browser's underlying CDP disconnect. */
  const fireDisconnect = () => {
    browser.isConnected.mockReturnValue(false);
    for (const l of disconnectListeners) l();
  };
  return { browser, pages, fireDisconnect };
}

describe("BrowserPool", () => {
  it("launches lazily — not on construction", () => {
    const launcher: BrowserLauncher = vi.fn(
      async () => makeBrowserDouble().browser,
    );
    new BrowserPool(launcher);
    expect(launcher).not.toHaveBeenCalled();
  });

  it("withTab launches the browser on first call and reuses it", async () => {
    const first = makeBrowserDouble();
    const launcher = vi.fn(async () => first.browser) as MockedFunction<
      BrowserLauncher
    >;
    const pool = new BrowserPool(launcher);
    await pool.withTab(async () => {});
    await pool.withTab(async () => {});
    expect(launcher).toHaveBeenCalledOnce();
    expect(first.browser.newPage).toHaveBeenCalledTimes(2);
  });

  it("withTab closes the page even if the callback throws", async () => {
    const { browser, pages } = makeBrowserDouble();
    const pool = new BrowserPool(async () => browser);
    await expect(
      pool.withTab(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(pages).toHaveLength(1);
    expect(pages[0].close).toHaveBeenCalledOnce();
  });

  it("relaunches the browser if it has disconnected", async () => {
    const first = makeBrowserDouble();
    const second = makeBrowserDouble();
    const browsers = [first.browser, second.browser];
    const launcher = vi.fn(async () => browsers.shift()!) as MockedFunction<
      BrowserLauncher
    >;
    const pool = new BrowserPool(launcher);
    await pool.withTab(async () => {});
    first.browser.isConnected.mockReturnValue(false);
    await pool.withTab(async () => {});
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(second.browser.newPage).toHaveBeenCalledOnce();
  });

  it("dispose closes the live browser and is idempotent", async () => {
    const { browser } = makeBrowserDouble();
    const pool = new BrowserPool(async () => browser);
    await pool.withTab(async () => {});
    await pool.dispose();
    await pool.dispose();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("dispose is a no-op before any launch", async () => {
    const launcher = vi.fn(async () => makeBrowserDouble().browser);
    const pool = new BrowserPool(launcher);
    await pool.dispose();
    expect(launcher).not.toHaveBeenCalled();
  });

  it("registers a disconnect listener on launch and evicts the cached browser when it fires", async () => {
    const first = makeBrowserDouble();
    const second = makeBrowserDouble();
    const browsers = [first.browser, second.browser];
    const launcher = vi.fn(async () => browsers.shift()!) as MockedFunction<
      BrowserLauncher
    >;
    const pool = new BrowserPool(launcher);
    await pool.withTab(async () => {});
    expect(first.browser.onDisconnected).toHaveBeenCalledOnce();
    // Simulate the browser's underlying CDP connection dropping.
    first.fireDisconnect();
    // Next call must launch a fresh browser; the cached reference was evicted
    // proactively by the disconnect listener, not lazily by isConnected().
    await pool.withTab(async () => {});
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(second.browser.newPage).toHaveBeenCalledOnce();
  });

  it("a stale disconnect from a previous browser does not evict the current one", async () => {
    // Cover the "this.browser === b" guard: a late-firing disconnect from an
    // already-replaced browser must not null out the new one.
    const first = makeBrowserDouble();
    const second = makeBrowserDouble();
    const browsers = [first.browser, second.browser];
    const launcher = vi.fn(async () => browsers.shift()!) as MockedFunction<
      BrowserLauncher
    >;
    const pool = new BrowserPool(launcher);
    await pool.withTab(async () => {});
    first.fireDisconnect();
    await pool.withTab(async () => {}); // launches second
    // Late disconnect from first — must be ignored.
    first.fireDisconnect();
    await pool.withTab(async () => {});
    // Still on the second browser, no third launch.
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(second.browser.newPage).toHaveBeenCalledTimes(2);
  });

  it("reuses an initial about:blank page on the first openPage (no extra tab)", async () => {
    const initial: PageLike & {
      close: MockedFunction<() => Promise<void>>;
      url: MockedFunction<() => string>;
    } = {
      close: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined as unknown),
      url: vi.fn(() => "about:blank"),
    } as never;
    const newPage = vi.fn(async () => makePageDouble());
    const browser: BrowserLike = {
      isConnected: () => true,
      close: async () => {},
      newPage,
      pages: vi.fn(async () => [initial]),
    } as never;
    const pool = new BrowserPool(async () => browser);

    const first = await pool.openPage();
    const second = await pool.openPage();

    expect(first).toBe(initial);
    expect(newPage).toHaveBeenCalledOnce();
    expect(second).not.toBe(initial);
  });
});

describe("BrowserPool — the startup window", () => {
  function headedDouble() {
    const startup = makePageDouble();
    const opened = makePageDouble();
    const browser = {
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => {}),
      newPage: vi.fn(async () => makePageDouble()),
      onDisconnected: vi.fn(),
      pages: vi.fn(async () => [startup]),
      openWindow: vi.fn(async () => opened),
    } as unknown as BrowserLike & {
      openWindow: MockedFunction<(url: string) => Promise<PageLike>>;
    };
    (startup as unknown as { url: () => string }).url = () => "about:blank";
    return { browser, startup, opened };
  }

  it("reuses Chrome's startup window instead of opening a second one", async () => {
    // Headed mode showed a window appear, a second appear, then the first
    // vanish: we were creating a new window and then closing the blank one
    // Chrome had already put on screen.
    const { browser, startup } = headedDouble();
    const pool = new BrowserPool(async () => browser);

    const page = await pool.openWindow("http://example.test/shell.html");

    expect(page).toBe(startup);
    expect(browser.openWindow).not.toHaveBeenCalled();
    expect(startup.goto).toHaveBeenCalled();
    expect(startup.close).not.toHaveBeenCalled();
  });

  it("opens a real window once the startup one is taken", async () => {
    const { browser } = headedDouble();
    const pool = new BrowserPool(async () => browser);

    await pool.openWindow("http://example.test/one");
    await pool.openWindow("http://example.test/two");

    expect(browser.openWindow).toHaveBeenCalledTimes(1);
  });
});
