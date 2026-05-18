import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type ChatSettings } from "../src/chat/settings.js";

describe("DEFAULT_SETTINGS", () => {
  it("comparisonMode defaults to false", () => {
    expect(DEFAULT_SETTINGS.comparisonMode).toBe(false);
  });

  it("ChatSettings type includes comparisonMode as boolean", () => {
    const s: ChatSettings = { ...DEFAULT_SETTINGS };
    expect(typeof s.comparisonMode).toBe("boolean");
  });
});
