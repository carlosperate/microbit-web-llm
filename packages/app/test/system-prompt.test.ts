import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "../src/chat/system-prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("tells the LLM it is a micro:bit coding assistant", () => {
    expect(SYSTEM_PROMPT).toMatch(/micro:bit/i);
    expect(SYSTEM_PROMPT).toMatch(/assistant/i);
  });

  it("describes the session_set_code + session_get_blocks_img multi-turn pattern", () => {
    expect(SYSTEM_PROMPT).toMatch(/session_set_code/);
    expect(SYSTEM_PROMPT).toMatch(/session_get_blocks_img/);
  });

  it("mentions the stateless get_blocks_img_from_code variant for previewing snippets", () => {
    expect(SYSTEM_PROMPT).toMatch(/get_blocks_img_from_code/);
  });

  it("does not reference session lifecycle — the iframe is the session", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/session_start/);
    expect(SYSTEM_PROMPT).not.toMatch(/session_end/);
    expect(SYSTEM_PROMPT).not.toMatch(/session_id/);
  });

  it("mentions MakeCode TypeScript (not standard Node.js)", () => {
    expect(SYSTEM_PROMPT).toMatch(/MakeCode/);
    expect(SYSTEM_PROMPT).toMatch(/TypeScript/);
  });
});
