import { test, expect, type Page } from "@playwright/test";

// MakeCode loads over the network — allow up to 60 s per action.
test.setTimeout(120_000);

async function waitForEditorReady(page: Page) {
  await expect(page.getByText("executor ready", { exact: true })).toBeVisible({ timeout: 60_000 });
}

async function clickButton(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click();
}

async function startSession(page: Page) {
  await clickButton(page, "start_session");
  await expect(page.locator("span").filter({ hasText: /^session:/ })).toBeVisible({ timeout: 5_000 });
}

test.describe("MakeCodePanel integration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForEditorReady(page);
  });

  test("editor loads and executor becomes ready", async ({ page }) => {
    await expect(page.getByText("executor ready", { exact: true })).toBeVisible();
  });

  test("start_session creates an active session", async ({ page }) => {
    await startSession(page);
    await expect(page.locator("span").filter({ hasText: /^session:/ })).toContainText("session:");
  });

  test("end_session clears the active session", async ({ page }) => {
    await startSession(page);
    await clickButton(page, "end_session");
    await expect(page.getByText("no active session")).toBeVisible({ timeout: 5_000 });
  });

  test("set_code then get_current_code round-trips the TypeScript", async ({ page }) => {
    await startSession(page);

    // Replace the default code with something distinctive
    await page.locator("textarea").fill('basic.showString("roundtrip")');
    await clickButton(page, "set_code");

    // Wait for set_code confirmation in the log
    await expect(page.getByText("set_code → ok")).toBeVisible({ timeout: 15_000 });

    await clickButton(page, "get_current_code");
    await expect(page.getByText(/get_current_code →.*roundtrip/)).toBeVisible({ timeout: 10_000 });
  });

  test("get_blocks_svg_from_code opens the SVG modal with content", async ({ page }) => {
    // Uses the default code in the textarea — no session needed
    await clickButton(page, "get_blocks_svg_from_code");

    // Modal appears
    await expect(page.getByTitle("blocks SVG")).toBeVisible({ timeout: 30_000 });

    // Log entry reports a non-trivial SVG size (> 1 KB)
    await expect(page.getByText(/get_blocks_svg_from_code → \d+\.\d+ KB/)).toBeVisible();
    const sizeText = await page.getByText(/get_blocks_svg_from_code → \d+\.\d+ KB/).textContent();
    const kb = parseFloat(sizeText!.match(/([\d.]+) KB/)![1]);
    expect(kb).toBeGreaterThan(1);

    // Close the modal
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("blocks SVG")).not.toBeVisible();
  });

  test("get_blocks_svg (session) opens the modal after set_code", async ({ page }) => {
    await startSession(page);
    await page.locator("textarea").fill('basic.showLeds(`# . . . #\n. # . # .\n. . # . .\n. # . # .\n# . . . #`)');
    await clickButton(page, "set_code");
    await expect(page.getByText("set_code → ok")).toBeVisible({ timeout: 15_000 });

    await clickButton(page, "get_blocks_svg (session)");
    await expect(page.getByTitle("blocks SVG")).toBeVisible({ timeout: 30_000 });
  });

  test("get_hex_file triggers a download with a valid hex file", async ({ page }) => {
    await startSession(page);
    await clickButton(page, "set_code");
    await expect(page.getByText("set_code → ok")).toBeVisible({ timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await clickButton(page, "get_hex_file (download)");
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("microbit.hex");

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString("utf8");

    // Intel Hex: every non-empty line starts with ':'
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines.slice(0, 20)) {
      expect(line).toMatch(/^:/);
    }
  });
});
