import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import { Launcher } from "chrome-launcher";
import { resolveChromePath } from "../../src/server/chrome-path.ts";
import { adaptPuppeteerBrowser } from "../../src/server/puppeteer-browser-adapter.ts";
import { PuppeteerDriver } from "../../src/server/puppeteer-driver.ts";
import { writeCode } from "../../src/shared/executor-ops.ts";
// Built shell-server: it resolves shell assets relative to its own module, so
// the prebuilt dist/shell/{shim.js,shell.html} are only found from dist.
import { startShellServer, type ShellServer } from "../../dist/server/shell-server.js";

// End-to-end proof that real MakeCode console diagnostics flow through the whole
// chain (page console -> adapter capture -> PuppeteerDriver.setProject error).
// Launches Chrome + loads makecode.microbit.org, so it's opt-in:
//   MKCP_PUPPETEER_IT=1 npx vitest run test/server/makecode-diagnostics.puppeteer.test.ts
const run = process.env.MKCP_PUPPETEER_IT ? describe : describe.skip;

// The user's example: `button.A` should be `Button.A`, `accelermeter` is a typo.
const BAD_CODE = `basic.showString('Happy Face')
input.onButtonPressed(button.A, function () {
    basic.showString('Angry Face')
})
accelermeter.onPeriodicMotion(100, function () {
    basic.showString('Angry Face')
})`;

run("MakeCode compiler diagnostics surface in setProject errors", () => {
  let browser: Browser;
  let shell: ShellServer;

  beforeAll(async () => {
    const executablePath = resolveChromePath({
      env: process.env,
      findSystemChrome: () => Launcher.getFirstInstallation(),
    });
    shell = await startShellServer();
    browser = await puppeteer.launch({ headless: true, executablePath });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await shell?.close();
  });

  it("attaches the real TS errors to the failed-to-compile message", async () => {
    const adapted = adaptPuppeteerBrowser(browser as never);
    const page = await adapted.newPage();
    await page.goto(shell.url, { waitUntil: "domcontentloaded" });
    await page.evaluate("window.__mkcp.ready()");

    const driver = new PuppeteerDriver(page);
    const err = await writeCode(driver, BAD_CODE).then(
      () => null,
      (e) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain("failed to compile to blocks");
    expect(err!.message).toContain("Compiler errors:");
    expect(err!.message).toMatch(/Cannot find name 'accelermeter'/);
    expect(err!.message).toMatch(/TS\d+/);
    await page.close();
  }, 75_000);
});
