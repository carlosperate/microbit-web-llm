import { describe, it, expect, vi } from "vitest";
import { resolveChromePath } from "../../src/server/chrome-path.ts";

describe("resolveChromePath", () => {
  it("returns PUPPETEER_EXECUTABLE_PATH when set", () => {
    const find = vi.fn(() => "/auto/detected/chrome");
    const path = resolveChromePath({
      env: { PUPPETEER_EXECUTABLE_PATH: "/custom/chrome" },
      findSystemChrome: find,
    });
    expect(path).toBe("/custom/chrome");
    expect(find).not.toHaveBeenCalled();
  });

  it("trims whitespace around PUPPETEER_EXECUTABLE_PATH", () => {
    expect(
      resolveChromePath({
        env: { PUPPETEER_EXECUTABLE_PATH: "  /custom/chrome  " },
        findSystemChrome: () => undefined,
      }),
    ).toBe("/custom/chrome");
  });

  it("falls back to findSystemChrome when env var is empty", () => {
    expect(
      resolveChromePath({
        env: { PUPPETEER_EXECUTABLE_PATH: "" },
        findSystemChrome: () => "/auto/chrome",
      }),
    ).toBe("/auto/chrome");
  });

  it("falls back to findSystemChrome when env var is unset", () => {
    expect(
      resolveChromePath({
        env: {},
        findSystemChrome: () => "/auto/chrome",
      }),
    ).toBe("/auto/chrome");
  });

  it("ignores unsubstituted MCPB template strings in env", () => {
    // MCPB passes optional user_config fields through as the literal
    // template when the user hasn't filled them in.
    expect(
      resolveChromePath({
        env: { PUPPETEER_EXECUTABLE_PATH: "${user_config.chrome_path}" },
        findSystemChrome: () => "/auto/chrome",
      }),
    ).toBe("/auto/chrome");
  });

  it("ignores templates with surrounding whitespace", () => {
    expect(
      resolveChromePath({
        env: { PUPPETEER_EXECUTABLE_PATH: "  ${user_config.chrome_path}  " },
        findSystemChrome: () => "/auto/chrome",
      }),
    ).toBe("/auto/chrome");
  });

  it("throws a readable error when no Chrome is found", () => {
    expect(() =>
      resolveChromePath({
        env: {},
        findSystemChrome: () => undefined,
      }),
    ).toThrow(/Could not locate Chrome.*PUPPETEER_EXECUTABLE_PATH/s);
  });

  it("throws a readable error when finder throws", () => {
    expect(() =>
      resolveChromePath({
        env: {},
        findSystemChrome: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow(/Could not locate Chrome.*PUPPETEER_EXECUTABLE_PATH/s);
  });
});
