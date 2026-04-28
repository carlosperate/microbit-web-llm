import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "../src/chat/system-prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("tells the LLM it is a micro:bit coding assistant", () => {
    expect(SYSTEM_PROMPT).toMatch(/micro:bit/i);
    expect(SYSTEM_PROMPT).toMatch(/assistant/i);
  });

  it("describes the set_code + get_blocks_image multi-turn pattern", () => {
    expect(SYSTEM_PROMPT).toMatch(/set_code/);
    expect(SYSTEM_PROMPT).toMatch(/get_blocks_image/);
  });

  it("mentions the stateless get_blocks_image_from_code variant for previewing snippets", () => {
    expect(SYSTEM_PROMPT).toMatch(/get_blocks_image_from_code/);
  });

  it("does not reference session lifecycle — the iframe is the session", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/start_session/);
    expect(SYSTEM_PROMPT).not.toMatch(/end_session/);
    expect(SYSTEM_PROMPT).not.toMatch(/session_id/);
  });

  it("mentions MakeCode TypeScript (not standard Node.js)", () => {
    expect(SYSTEM_PROMPT).toMatch(/MakeCode/);
    expect(SYSTEM_PROMPT).toMatch(/TypeScript/);
  });
});
