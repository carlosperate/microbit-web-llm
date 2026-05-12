import { describe, it, expect, vi } from "vitest";
import { adaptPuppeteerBrowser } from "../../src/server/puppeteer-browser-adapter.ts";

describe("adaptPuppeteerBrowser → openWindow", () => {
  it("sends Target.createTarget with newWindow: true and resolves the new page", async () => {
    const targetId = "T-1";
    const fakePage = {
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
      url: () => "about:blank",
    };
    const fakeTarget = {
      _targetId: targetId,
      page: vi.fn(async () => fakePage),
    };
    const cdpSend = vi.fn(async (method: string, _params: unknown) => {
      if (method === "Target.createTarget") return { targetId };
      return {};
    });
    const cdp = {
      send: cdpSend,
      detach: vi.fn(async () => {}),
    };
    const browser = {
      isConnected: () => true,
      close: vi.fn(async () => {}),
      newPage: vi.fn(),
      pages: vi.fn(async () => [fakePage]),
      target: () => ({ createCDPSession: async () => cdp }),
      waitForTarget: vi.fn(
        async (predicate: (t: unknown) => boolean) => {
          if (!predicate(fakeTarget)) throw new Error("predicate failed");
          return fakeTarget;
        },
      ),
    };

    const adapted = adaptPuppeteerBrowser(browser as never);
    const page = await adapted.openWindow!("http://example/shell.html");

    expect(cdpSend).toHaveBeenCalledWith(
      "Target.createTarget",
      expect.objectContaining({ newWindow: true }),
    );
    expect(fakeTarget.page).toHaveBeenCalled();
    expect(fakePage.goto).toHaveBeenCalledWith(
      "http://example/shell.html",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(page).toBe(fakePage);
  });
});
