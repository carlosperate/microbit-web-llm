import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "../src/chat/system-prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("tells the LLM it is a micro:bit coding assistant", () => {
    expect(SYSTEM_PROMPT).toMatch(/micro:bit/i);
    expect(SYSTEM_PROMPT).toMatch(/assistant/i);
  });

  it("describes the session lifecycle", () => {
    expect(SYSTEM_PROMPT).toMatch(/start_session/);
    expect(SYSTEM_PROMPT).toMatch(/end_session/);
  });

  it("describes the set_code + get_blocks_svg multi-turn pattern", () => {
    expect(SYSTEM_PROMPT).toMatch(/set_code/);
    expect(SYSTEM_PROMPT).toMatch(/get_blocks_svg/);
  });

  it("mentions the stateless _from_code variants", () => {
    expect(SYSTEM_PROMPT).toMatch(/get_blocks_svg_from_code/);
    expect(SYSTEM_PROMPT).toMatch(/get_hex_file_from_code/);
  });

  it("mentions MakeCode TypeScript (not standard Node.js)", () => {
    expect(SYSTEM_PROMPT).toMatch(/MakeCode/);
    expect(SYSTEM_PROMPT).toMatch(/TypeScript/);
  });
});
