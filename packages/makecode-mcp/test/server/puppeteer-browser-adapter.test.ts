import { describe, it, expect, vi } from "vitest";
import { adaptPuppeteerBrowser } from "../../src/server/puppeteer-browser-adapter.ts";

function makePage() {
  return {
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined),
    url: () => "about:blank",
  };
}

describe("adaptPuppeteerBrowser → openWindow", () => {
  it("creates a new window via CDP and resolves the new page (identified by set-difference, not by private _targetId)", async () => {
    // CDP `Target.createTarget` with `newWindow: true` keeps headed-mode
    // parity (real OS windows, not just new tabs). The adapter then picks
    // the new page out of `browser.pages()` by set-difference against a
    // pre-snapshot — no reliance on Puppeteer's renamed `_targetId` field.
    const existing = makePage();
    const created = makePage();
    let createTargetCalled = false;
    const cdp = {
      send: vi.fn(async (method: string, _params: unknown) => {
        if (method === "Target.createTarget") {
          createTargetCalled = true;
          return { targetId: "ignored" };
        }
        return {};
      }),
      detach: vi.fn(async () => {}),
    };
    const browser = {
      isConnected: () => true,
      close: vi.fn(async () => {}),
      newPage: vi.fn(),
      pages: vi.fn(async () => (createTargetCalled ? [existing, created] : [existing])),
      target: () => ({ createCDPSession: async () => cdp }),
    };

    const adapted = adaptPuppeteerBrowser(browser as never);
    const page = await adapted.openWindow!("http://example/shell.html");

    expect(cdp.send).toHaveBeenCalledWith(
      "Target.createTarget",
      expect.objectContaining({ newWindow: true, url: "about:blank" }),
    );
    expect(page).toBe(created);
    expect(created.goto).toHaveBeenCalledWith(
      "http://example/shell.html",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("instruments newPage so console TS diagnostics surface via recentDiagnostics", async () => {
    let consoleListener: ((msg: { text(): string }) => void) | undefined;
    const rawPage = {
      ...makePage(),
      on: vi.fn((event: string, cb: (msg: { text(): string }) => void) => {
        if (event === "console") consoleListener = cb;
      }),
    };
    const browser = {
      isConnected: () => true,
      close: vi.fn(async () => {}),
      newPage: vi.fn(async () => rawPage),
      pages: vi.fn(async () => [rawPage]),
      target: () => ({ createCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
    };
    const adapted = adaptPuppeteerBrowser(browser as never);
    const page = await adapted.newPage();

    // Identity preserved — the raw page IS the PageLike, just instrumented.
    expect(page).toBe(rawPage);
    expect(page.recentDiagnostics).toBeTypeOf("function");
    expect(page.recentDiagnostics!(5000)).toEqual([]);

    // Feed it a real MakeCode console error.
    consoleListener?.({
      text: () => "error: main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.\n",
    });
    expect(page.recentDiagnostics!(5000)).toEqual([
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
  });

  it("forwards onDisconnected listeners to the underlying browser's 'disconnected' event", () => {
    const listeners: Array<{ event: string; cb: () => void }> = [];
    const browser = {
      isConnected: () => true,
      close: vi.fn(async () => {}),
      newPage: vi.fn(),
      pages: vi.fn(async () => []),
      target: () => ({ createCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
      on: vi.fn((event: string, cb: () => void) => listeners.push({ event, cb })),
    };
    const adapted = adaptPuppeteerBrowser(browser as never);
    const listener = vi.fn();
    adapted.onDisconnected!(listener);
    expect(browser.on).toHaveBeenCalledWith("disconnected", expect.any(Function));
    // Fire the underlying event — adapter must invoke the registered listener.
    listeners.find((l) => l.event === "disconnected")!.cb();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("times out with a clear error if the new window never appears (no silent hang)", async () => {
    vi.useFakeTimers();
    try {
      const existing = makePage();
      const cdp = {
        send: vi.fn(async () => ({})),
        detach: vi.fn(async () => {}),
      };
      const browser = {
        isConnected: () => true,
        close: vi.fn(async () => {}),
        newPage: vi.fn(),
        // pages() never grows — simulates a `Target.createTarget` that was
        // acknowledged at the CDP level but whose page never materialised.
        pages: vi.fn(async () => [existing]),
        target: () => ({ createCDPSession: async () => cdp }),
      };
      const adapted = adaptPuppeteerBrowser(browser as never);

      const pending = adapted.openWindow!("http://example/shell.html");
      const settled = pending.catch((e) => e);
      // Advance past the 10 s deadline. Each tick runs all queued polling
      // sleeps; advancing in chunks lets the pages() polls resolve.
      for (let i = 0; i < 500; i++) await vi.advanceTimersByTimeAsync(50);
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /openWindow timed out after 10s/i,
      );
      // CDP session should still be detached on the failure path.
      expect(cdp.detach).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
