import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { Launcher } from "chrome-launcher";
import { resolveChromePath } from "../../src/server/chrome-path.ts";
import { isDeadPageError } from "../../src/server/page-errors.ts";

// Pins isDeadPageError against the *real* Puppeteer error wording. The unit
// test (page-errors.test.ts) uses hard-coded strings; this one closes a real
// tab so a Puppeteer upgrade that changes the message fails loudly here instead
// of silently breaking dead-page recovery. Launches Chrome, so it's opt-in:
//   MKCP_PUPPETEER_IT=1 npx vitest run test/server/page-errors.puppeteer.test.ts
const run = process.env.MKCP_PUPPETEER_IT ? describe : describe.skip;

// Captures both async rejections and synchronous throws: Puppeteer throws the
// detached-frame guard synchronously from a method decorator, while a closed
// page rejects.
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

run("isDeadPageError — real Puppeteer errors", () => {
  let browser: Browser;
  beforeAll(async () => {
    const executablePath = resolveChromePath({
      env: process.env,
      findSystemChrome: () => Launcher.getFirstInstallation(),
    });
    browser = await puppeteer.launch({ headless: true, executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it("recognises the error from evaluating on a closed page", async () => {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.close();
    // Brief settle so the target is fully gone, matching the real "stale cached
    // tab" case rather than an in-flight close race.
    await new Promise((r) => setTimeout(r, 600));
    const err = await captureError(() => page.evaluate("1+1"));
    expect(err).not.toBeNull();
    expect(isDeadPageError(err)).toBe(true);
  });

  it("recognises the error from evaluating on a detached frame", async () => {
    const page = await browser.newPage();
    await page.setContent('<iframe id="f" srcdoc="<b>hi</b>"></iframe>');
    await new Promise((r) => setTimeout(r, 200));
    const frame = await (await page.$("#f"))!.contentFrame();
    await page.evaluate(() => document.getElementById("f")!.remove());
    await new Promise((r) => setTimeout(r, 100));
    const err = await captureError(() => frame!.evaluate("1+1"));
    expect(err).not.toBeNull();
    expect(isDeadPageError(err)).toBe(true);
    await page.close();
  });
});
