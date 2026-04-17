import { describe, it, expect } from "vitest";
import { tools, toolNames } from "../../src/shared/tools.ts";

describe("tools", () => {
  it("exports exactly 8 tools", () => {
    expect(tools).toHaveLength(8);
  });

  it("every tool is an OpenAI function-calling descriptor", () => {
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(typeof tool.function.description).toBe("string");
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters.type).toBe("object");
      expect(tool.function.parameters).toHaveProperty("properties");
      expect(Array.isArray(tool.function.parameters.required)).toBe(true);
    }
  });

  it("contains exactly the expected tool names", () => {
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toEqual(
      [
        "start_session",
        "end_session",
        "get_current_code",
        "set_code",
        "get_blocks_svg",
        "get_hex_file",
        "get_blocks_svg_from_code",
        "get_hex_file_from_code",
      ].sort(),
    );
  });

  it("toolNames matches the tools array", () => {
    expect(toolNames.sort()).toEqual(tools.map((t) => t.function.name).sort());
  });

  it("start_session takes no required args", () => {
    const t = tools.find((x) => x.function.name === "start_session")!;
    expect(t.function.parameters.required).toEqual([]);
  });

  it.each([
    "end_session",
    "get_current_code",
    "get_blocks_svg",
    "get_hex_file",
  ])("stateful tool %s requires session_id only", (name) => {
    const t = tools.find((x) => x.function.name === name)!;
    expect(t.function.parameters.required).toEqual(["session_id"]);
    expect(t.function.parameters.properties).toHaveProperty("session_id");
    expect(
      (t.function.parameters.properties as Record<string, { type: string }>)
        .session_id.type,
    ).toBe("string");
  });

  it("set_code requires session_id and code", () => {
    const t = tools.find((x) => x.function.name === "set_code")!;
    expect(t.function.parameters.required.sort()).toEqual(
      ["code", "session_id"].sort(),
    );
  });

  it.each(["get_blocks_svg_from_code", "get_hex_file_from_code"])(
    "session-less tool %s requires only code",
    (name) => {
      const t = tools.find((x) => x.function.name === name)!;
      expect(t.function.parameters.required).toEqual(["code"]);
      expect(t.function.parameters.properties).not.toHaveProperty("session_id");
    },
  );
});
