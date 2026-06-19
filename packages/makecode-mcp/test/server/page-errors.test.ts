import { describe, it, expect } from "vitest";
import { isDeadPageError } from "../../src/server/page-errors.ts";

describe("isDeadPageError", () => {
  it("matches the Puppeteer dead-page / detached-frame messages", () => {
    const dead = [
      "Attempted to use detached Frame '16147B7AF484C3BE9700F05BAAACA7D3'",
      "Protocol error (Runtime.callFunctionOn): Target closed",
      "Session closed. Most likely the page has been closed.",
      "Execution context was destroyed, most likely because of a navigation",
      "Navigating frame was detached",
    ];
    for (const m of dead) {
      expect(isDeadPageError(new Error(m))).toBe(true);
    }
  });

  it("also matches when handed a bare string", () => {
    expect(isDeadPageError("Attempted to use detached Frame 'X'")).toBe(true);
  });

  it("does not match normal tool failures that must propagate unchanged", () => {
    const live = [
      "Code was loaded into the editor but failed to compile to blocks.",
      "No code loaded in the editor. Call session_set_code first.",
      "boom",
    ];
    for (const m of live) {
      expect(isDeadPageError(new Error(m))).toBe(false);
    }
  });
});
