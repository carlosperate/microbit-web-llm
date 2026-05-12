import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { PuppeteerTabPool } from "../../src/server/puppeteer-tab-pool.ts";
import type {
  BrowserPoolLike,
  PageLike,
} from "../../src/server/browser-pool.ts";

vi.mock("../../src/server/shell/shell-server.js", () => ({
  startShellServer: vi.fn(async () => ({
    url: "http://127.0.0.1:0/shell.html",
    renderUrl: "http://127.0.0.1:0/render.html",
    close: async () => {},
  })),
}));

vi.mock("../../src/server/puppeteer-driver.js", () => ({
  PuppeteerDriver: class {
    constructor(public page: unknown) {}
  },
}));

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
    dispose: vi.fn(async () => {}),
    pages,
  } as never;
}

describe("PuppeteerTabPool — two-pool routing", () => {
  it("openTab uses the session pool, not the render pool", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.openTab();

    expect(sessionPool.openPage).toHaveBeenCalledOnce();
    expect(renderPool.openPage).not.toHaveBeenCalled();
  });

  it("renderBlocksImage uses the render pool, not the session pool", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    // Render page evaluate returns a base64 string.
    renderPool.openPage.mockImplementationOnce(async () => {
      const p = makePage();
      (p.evaluate as MockedFunction<() => Promise<unknown>>).mockResolvedValue(
        "PNGBASE64",
      );
      renderPool.pages.push(p);
      return p;
    });
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    const out = await pool.renderBlocksImage("code");

    expect(out).toBe("PNGBASE64");
    expect(renderPool.openPage).toHaveBeenCalledOnce();
    expect(sessionPool.openPage).not.toHaveBeenCalled();
  });

  it("withTransientTab uses the render pool, not the session pool", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.withTransientTab(async () => "ok");

    expect(renderPool.openPage).toHaveBeenCalledOnce();
    expect(sessionPool.openPage).not.toHaveBeenCalled();
  });

  it("dispose disposes both pools", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.dispose();

    expect(renderPool.dispose).toHaveBeenCalledOnce();
    expect(sessionPool.dispose).toHaveBeenCalledOnce();
  });
});
