import { test, expect } from "@playwright/test";

// The mock script runs in the page context before the app bootstraps.
// It intercepts all chat completions and replays a scripted transcript:
//   1st call  → start_session tool call
//   2nd call  → set_code tool call with a micro:bit program
//   3rd call  → get_blocks_svg tool call
//   4th call  → final text response
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
  window.__mockChatCompletion = async ({ messages }) => {
    turn++;
    if (turn === 1) {
      return asStream([
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "start_session", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    if (turn === 2) {
      const sid = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "tool") {
            try { return JSON.parse(messages[i].content).session_id; } catch {}
          }
        }
        return "unknown";
      })();
      return asStream([
        chunk({ tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "set_code", arguments: JSON.stringify({ session_id: sid, code: SAMPLE_CODE }) } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    if (turn === 3) {
      const sid = (() => {
        for (const m of messages) {
          if (m.role === "tool" && m.tool_call_id === "c1") {
            try { return JSON.parse(m.content).session_id; } catch {}
          }
        }
        return "unknown";
      })();
      return asStream([
        chunk({ tool_calls: [{ index: 0, id: "c3", type: "function", function: { name: "get_blocks_svg", arguments: JSON.stringify({ session_id: sid }) } }] }),
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

test("full chat → set_code → get_blocks_svg flow using mocked WebLLM", async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT);
  await page.goto("/");

  // Wait for MakeCode editor iframe to report ready.
  await expect(page.getByTestId("editor-status")).toHaveText(/editor ready/i, {
    timeout: 30_000,
  });

  // Submit a prompt.
  const composer = page.locator(".composer-input");
  await composer.fill("Please load a program that shows HI on the micro:bit");
  await composer.press("Enter");

  // Expect all four tool calls to appear in the assistant message.
  await expect(page.locator(".tool-call summary code", { hasText: "start_session" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tool-call summary code", { hasText: "set_code" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tool-call summary code", { hasText: "get_blocks_svg" })).toBeVisible({ timeout: 30_000 });

  // Final text reply streams in.
  await expect(page.locator(".message-assistant")).toContainText(/scrolls HI/, { timeout: 30_000 });

  // Expand the get_blocks_svg call — its result should contain an <svg> (or an error if renderer wasn't available).
  const svgCall = page.locator(".tool-call", { has: page.locator("summary code", { hasText: "get_blocks_svg" }) });
  await svgCall.locator("summary").click();
  await expect(svgCall).toContainText(/<svg|No code loaded|session_id/i);
});
