import { test, expect, type Page } from "@playwright/test";

// MakeCode loads over the network; the editor-ready wait below allows up to
// 45 s for that first paint, plus headroom for a single compile/render step.
test.setTimeout(75_000);

async function waitForEditorReady(page: Page) {
  await expect(page.getByText("executor ready", { exact: true })).toBeVisible({ timeout: 45_000 });
}

async function clickButton(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click();
}

test.describe("MakeCodePanel integration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForEditorReady(page);
  });

  test("editor loads and executor becomes ready", async ({ page }) => {
    await expect(page.getByText("executor ready", { exact: true })).toBeVisible();
  });

  test("session_set_code then session_get_code round-trips the TypeScript", async ({ page }) => {
    // Replace the default code with something distinctive
    await page.locator("textarea").fill('basic.showString("roundtrip")');
    await clickButton(page, "session_set_code");

    // Wait for session_set_code confirmation in the log
    await expect(page.getByText("session_set_code → ok")).toBeVisible({ timeout: 15_000 });

    await clickButton(page, "session_get_code");
    await expect(page.getByText(/session_get_code →.*roundtrip/)).toBeVisible({ timeout: 10_000 });
  });

  test("get_blocks_img_from_code opens the PNG modal with content", async ({ page }) => {
    await clickButton(page, "get_blocks_img_from_code");

    // Modal appears
    await expect(page.getByAltText("blocks PNG")).toBeVisible({ timeout: 30_000 });

    // Log entry reports a non-trivial base64 size (> 1 KB)
    await expect(page.getByText(/get_blocks_img_from_code → \d+\.\d+ KB/)).toBeVisible();
    const sizeText = await page.getByText(/get_blocks_img_from_code → \d+\.\d+ KB/).textContent();
    const kb = parseFloat(sizeText!.match(/([\d.]+) KB/)![1]);
    expect(kb).toBeGreaterThan(1);

    // Close the modal
    await page.keyboard.press("Escape");
    await expect(page.getByAltText("blocks PNG")).not.toBeVisible();
  });

  test("session_get_blocks_img (editor) opens the modal after session_set_code", async ({ page }) => {
    await page.locator("textarea").fill('basic.showLeds(`# . . . #\n. # . # .\n. . # . .\n. # . # .\n# . . . #`)');
    await clickButton(page, "session_set_code");
    await expect(page.getByText("session_set_code → ok")).toBeVisible({ timeout: 15_000 });

    await clickButton(page, "session_get_blocks_img (editor)");
    await expect(page.getByAltText("blocks PNG")).toBeVisible({ timeout: 30_000 });
  });

  test("session_get_hex_file triggers a download with a valid hex file", async ({ page }) => {
    await clickButton(page, "session_set_code");
    await expect(page.getByText("session_set_code → ok")).toBeVisible({ timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await clickButton(page, "session_get_hex_file (download)");
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
