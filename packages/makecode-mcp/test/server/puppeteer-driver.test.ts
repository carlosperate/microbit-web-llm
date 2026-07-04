import { describe, it, expect, vi } from "vitest";
import { PuppeteerDriver } from "../../src/server/puppeteer-driver.ts";
import type { PageLike } from "../../src/server/browser-pool.ts";

function fakePage(
  shimResult: unknown,
  diagnostics: string[] = [],
): PageLike & { recentDiagnostics: () => string[] } {
  return {
    evaluate: vi.fn(async () => shimResult),
    recentDiagnostics: vi.fn(() => diagnostics),
    close: vi.fn(async () => {}),
    goto: vi.fn(async () => undefined),
  } as never;
}

const COMPILE_FAIL =
  "Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again.";

async function setProjectError(driver: PuppeteerDriver): Promise<string> {
  try {
    await driver.setProject({ text: { "main.ts": "x" } });
    throw new Error("expected setProject to reject");
  } catch (e) {
    return (e as Error).message;
  }
}

describe("PuppeteerDriver.setProject — diagnostics enrichment", () => {
  it("appends captured compiler diagnostics to a compile-failure error", async () => {
    const diags = [
      "main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?",
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ];
    const page = fakePage({ ok: false, error: COMPILE_FAIL }, diags);
    const msg = await setProjectError(new PuppeteerDriver(page));
    expect(msg).toContain(COMPILE_FAIL);
    expect(msg).toContain("Compiler errors:");
    expect(msg).toContain("main.ts(2,23): error TS2552");
    expect(msg).toContain("main.ts(5,1): error TS2304");
  });

  it("leaves the error untouched when no recent diagnostics were captured", async () => {
    const page = fakePage({ ok: false, error: COMPILE_FAIL }, []);
    const msg = await setProjectError(new PuppeteerDriver(page));
    expect(msg).toBe(COMPILE_FAIL);
    expect(msg).not.toContain("Compiler errors:");
  });

  it("does not staple diagnostics onto an unrelated (non-compile) error", async () => {
    // A transport failure with stale diagnostics still around must surface as-is.
    const page = fakePage(
      { ok: false, error: "Attempted to use detached Frame 'X'" },
      ["main.ts(2,23): error TS2552: Cannot find name 'button'."],
    );
    const msg = await setProjectError(new PuppeteerDriver(page));
    expect(msg).toBe("Attempted to use detached Frame 'X'");
    expect(page.recentDiagnostics).not.toHaveBeenCalled();
  });

  it("resolves without throwing when the shim result is ok", async () => {
    const page = fakePage({ ok: true, value: undefined });
    await expect(
      new PuppeteerDriver(page).setProject({ text: { "main.ts": "x" } }),
    ).resolves.toBeUndefined();
  });

  it("works when the page has no recentDiagnostics method (browser-shaped page)", async () => {
    const page = {
      evaluate: vi.fn(async () => ({ ok: false, error: COMPILE_FAIL })),
      close: vi.fn(async () => {}),
      goto: vi.fn(async () => undefined),
    } as never as PageLike;
    const msg = await setProjectError(new PuppeteerDriver(page));
    expect(msg).toBe(COMPILE_FAIL);
  });
});
