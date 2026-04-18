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
  const browser: BrowserLike & {
    isConnected: MockedFunction<() => boolean>;
    close: MockedFunction<() => Promise<void>>;
    newPage: MockedFunction<() => Promise<PageLike>>;
  } = {
    isConnected: vi.fn(() => true),
    close: vi.fn(async () => {}),
    newPage: vi.fn(async () => {
      const p = makePageDouble();
      pages.push(p);
      return p;
    }),
  } as never;
  return { browser, pages };
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
});
