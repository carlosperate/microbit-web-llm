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

describe("PuppeteerTabPool — two-pool routing", () => {
  it("openTab uses the session pool, not the render pool", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.openTab();

    expect(sessionPool.openWindow).toHaveBeenCalledOnce();
    expect(renderPool.openWindow).not.toHaveBeenCalled();
    expect(renderPool.openPage).not.toHaveBeenCalled();
  });

  it("openTab waits for the MakeCode editor to become ready before resolving", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((r) => {
      resolveReady = r;
    });
    sessionPool.openWindow.mockImplementationOnce(async (_url: string) => {
      const p = makePage();
      (p.evaluate as MockedFunction<() => Promise<unknown>>).mockImplementation(
        () => readyPromise as unknown as Promise<unknown>,
      );
      sessionPool.pages.push(p);
      return p;
    });
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    let resolved = false;
    const openP = pool.openTab().then((h) => {
      resolved = true;
      return h;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    resolveReady();
    await openP;
    expect(resolved).toBe(true);
    // The ready check should have been evaluated against window.__mkcp.ready().
    const page = sessionPool.pages[0];
    expect(page.evaluate).toHaveBeenCalled();
    const firstArg = (page.evaluate as MockedFunction<(...a: unknown[]) => Promise<unknown>>).mock.calls[0][0];
    expect(String(firstArg)).toContain("__mkcp.ready");
  });

  it("openTab appends session and label to the shell URL", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.openTab({ sessionId: "abc-123", label: "first session" });

    expect(sessionPool.openWindow).toHaveBeenCalledOnce();
    const url = new URL(sessionPool.openWindow.mock.calls[0][0]);
    expect(url.pathname).toMatch(/shell\.html$/);
    expect(url.searchParams.get("session")).toBe("abc-123");
    expect(url.searchParams.get("label")).toBe("first session");
  });

  it("openTab omits the label param when no label is given", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.openTab({ sessionId: "abc-123" });

    const url = new URL(sessionPool.openWindow.mock.calls[0][0]);
    expect(url.searchParams.get("session")).toBe("abc-123");
    expect(url.searchParams.has("label")).toBe(false);
  });

  it("openTab creates each session in its own window via openWindow(url)", async () => {
    const renderPool = makePoolDouble();
    const sessionPool = makePoolDouble();
    const pool = new PuppeteerTabPool({ renderPool, sessionPool });

    await pool.openTab();
    await pool.openTab();

    expect(sessionPool.openWindow).toHaveBeenCalledTimes(2);
    // Both calls receive the shell URL
    const urls = sessionPool.openWindow.mock.calls.map((c) => c[0]);
    expect(urls.every((u) => typeof u === "string" && u.includes("shell"))).toBe(
      true,
    );
    expect(sessionPool.openPage).not.toHaveBeenCalled();
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
