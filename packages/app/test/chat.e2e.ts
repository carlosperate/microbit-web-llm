import { test, expect } from "@playwright/test";

// The mock script runs in the page context before the app bootstraps.
// It intercepts all chat completions and replays a browser-target transcript:
//   1st call  → session_set_code
//   2nd call  → session_get_blocks_img
//   3rd call  → final plain-text response
const INIT_SCRIPT = `
(() => {
  const SAMPLE_CODE = 'basic.showString("HI")';
  const asStream = (chunks) => ({
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });
  const chunk = (delta, finish_reason = null) => ({ choices: [{ delta, finish_reason }] });
  let turn = 0;
  window.__mockChatCompletion = async () => {
    turn++;
    if (turn === 1) {
      return asStream([
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "session_set_code", arguments: JSON.stringify({ code: SAMPLE_CODE }) } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    if (turn === 2) {
      return asStream([
        chunk({ tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "session_get_blocks_img", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    return asStream([
      chunk({ content: "Loaded a micro:bit program that scrolls HI across the LEDs." }),
      chunk({}, "stop"),
    ]);
  };
})();
`;

test("full chat renders inline blocks image in browser-tool happy path", async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT);
  await page.goto("/");

  // Wait for MakeCode editor iframe to report ready.
  await expect(page.locator('.chat-pane[data-executor-ready="true"]')).toBeVisible({
    timeout: 30_000,
  });

  // Submit a prompt.
  const composer = page.locator(".composer-input");
  await composer.fill("Please load a program that shows HI on the micro:bit");
  await composer.press("Enter");

  // Expect both browser-side tool calls to appear in the assistant message.
  await expect(page.locator(".tool-call summary code", { hasText: "session_set_code" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tool-call summary code", { hasText: "session_get_blocks_img" })).toBeVisible({ timeout: 30_000 });

  const setCodeCall = page.locator(".tool-call", {
    has: page.locator("summary code", { hasText: "session_set_code" }),
  });
  const blocksCall = page.locator(".tool-call", {
    has: page.locator("summary code", { hasText: "session_get_blocks_img" }),
  });
  await expect(setCodeCall).not.toHaveClass(/tool-call-error/);
  await expect(blocksCall).not.toHaveClass(/tool-call-error/);

  // Browser adapter should append an inline image part for blocks results.
  await expect(page.getByAltText("MakeCode blocks")).toBeVisible({ timeout: 30_000 });

  // Final text reply streams in.
  await expect(page.locator(".message-assistant")).toContainText(/scrolls HI/, { timeout: 30_000 });
});
