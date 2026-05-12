import { describe, it, expect } from "vitest";
import { parseHeadedFlag } from "../../src/server/cli-options.ts";

describe("parseHeadedFlag", () => {
  it("returns false by default", () => {
    expect(parseHeadedFlag([], {})).toBe(false);
  });

  it("returns true when --headed appears in argv", () => {
    expect(parseHeadedFlag(["node", "bin.js", "--headed"], {})).toBe(true);
  });

  it("returns true when MKCP_HEADED=1 in env", () => {
    expect(parseHeadedFlag([], { MKCP_HEADED: "1" })).toBe(true);
  });

  it("returns true when MKCP_HEADED=true in env", () => {
    expect(parseHeadedFlag([], { MKCP_HEADED: "true" })).toBe(true);
  });

  it("ignores empty/zero MKCP_HEADED values", () => {
    expect(parseHeadedFlag([], { MKCP_HEADED: "" })).toBe(false);
    expect(parseHeadedFlag([], { MKCP_HEADED: "0" })).toBe(false);
    expect(parseHeadedFlag([], { MKCP_HEADED: "off" })).toBe(false);
  });
});
