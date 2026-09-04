import { describe, it, expect } from "vitest";
import { BRIDGE_CSP } from "../../src/server/shell-server.ts";

describe("bridge page CSP", () => {
  it("lets the bridge frame MakeCode", () => {
    expect(BRIDGE_CSP).toContain("frame-src https://makecode.microbit.org");
  });

  it("declares no frame-ancestors, so a sandboxed host can embed it", () => {
    // An MCP Apps widget runs at an opaque origin, and no frame-ancestors
    // source matches one, `*` included. Declaring it made hosts refuse to
    // render the bridge; widget-bridge.puppeteer.test.ts proves the behaviour.
    expect(BRIDGE_CSP).not.toContain("frame-ancestors");
  });
});
