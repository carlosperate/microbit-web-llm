import { describe, it, expect } from "vitest";
import {
  browserTools,
  browserToolNames,
  serverTools,
  serverToolNames,
} from "../../src/shared/tools.ts";

describe("browserTools", () => {
  // The browser target exposes the iframe directly as the session, so the
  // tool list does not include session_start / session_end and no tool
  // carries a session_id parameter.

  it("exports exactly 5 tools", () => {
    expect(browserTools).toHaveLength(5);
  });

  it("every tool is an OpenAI function-calling descriptor", () => {
    for (const tool of browserTools) {
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
    expect(browserTools.map((t) => t.function.name).sort()).toEqual(
      [
        "session_get_code",
        "session_set_code",
        "session_get_blocks_img",
        "session_get_hex_file",
        "get_blocks_img_from_code",
      ].sort(),
    );
  });

  it("browserToolNames matches the browserTools array", () => {
    expect(browserToolNames.sort()).toEqual(
      browserTools.map((t) => t.function.name).sort(),
    );
  });

  it("does NOT include session_start or session_end", () => {
    const names = browserTools.map((t) => t.function.name);
    expect(names).not.toContain("session_start");
    expect(names).not.toContain("session_end");
  });

  it("no browser tool takes a session_id parameter", () => {
    for (const tool of browserTools) {
      expect(tool.function.parameters.properties).not.toHaveProperty("session_id");
      expect(tool.function.parameters.required).not.toContain("session_id");
    }
  });

  it.each(["session_get_code", "session_get_blocks_img", "session_get_hex_file"])(
    "stateful tool %s takes no arguments",
    (name) => {
      const t = browserTools.find((x) => x.function.name === name)!;
      expect(t.function.parameters.required).toEqual([]);
      expect(Object.keys(t.function.parameters.properties)).toEqual([]);
    },
  );

  it("session_set_code requires only `code`", () => {
    const t = browserTools.find((x) => x.function.name === "session_set_code")!;
    expect(t.function.parameters.required).toEqual(["code"]);
    expect(t.function.parameters.properties).toHaveProperty("code");
    expect(t.function.parameters.properties).not.toHaveProperty("session_id");
  });

  it("stateless tool get_blocks_img_from_code requires only `code`", () => {
    const t = browserTools.find(
      (x) => x.function.name === "get_blocks_img_from_code",
    )!;
    expect(t.function.parameters.required).toEqual(["code"]);
    expect(t.function.parameters.properties).toHaveProperty("code");
    expect(t.function.parameters.properties).not.toHaveProperty("session_id");
  });

  it("session_set_code description hints at natural follow-ups", () => {
    const t = browserTools.find((x) => x.function.name === "session_set_code")!;
    expect(t.function.description).toMatch(/session_get_blocks_img|session_get_hex_file/);
  });

  it("does NOT include get_hex_file_from_code (server-only tool)", () => {
    const names = browserTools.map((t) => t.function.name);
    expect(names).not.toContain("get_hex_file_from_code");
  });
});

describe("serverTools", () => {
  // The server target can serve many LLM clients from a single process, so
  // sessions are first-class.

  it("exports exactly 8 tools", () => {
    expect(serverTools).toHaveLength(8);
  });

  it("contains exactly the expected tool names", () => {
    expect(serverTools.map((t) => t.function.name).sort()).toEqual(
      [
        "session_start",
        "session_end",
        "session_get_code",
        "session_set_code",
        "session_get_blocks_img",
        "session_get_hex_file",
        "get_blocks_img_from_code",
        "get_hex_file_from_code",
      ].sort(),
    );
  });

  it("serverToolNames matches the serverTools array", () => {
    expect(serverToolNames.sort()).toEqual(
      serverTools.map((t) => t.function.name).sort(),
    );
  });

  it("session_start takes no required args", () => {
    const t = serverTools.find((x) => x.function.name === "session_start")!;
    expect(t.function.parameters.required).toEqual([]);
  });

  it("session_start accepts an optional label", () => {
    const t = serverTools.find((x) => x.function.name === "session_start")!;
    expect(t.function.parameters.properties).toHaveProperty("label");
    expect(t.function.parameters.properties.label.type).toBe("string");
    expect(t.function.parameters.required).not.toContain("label");
  });

  it.each([
    "session_end",
    "session_get_code",
    "session_get_blocks_img",
    "session_get_hex_file",
  ])("stateful tool %s requires session_id only", (name) => {
    const t = serverTools.find((x) => x.function.name === name)!;
    expect(t.function.parameters.required).toEqual(["session_id"]);
    expect(t.function.parameters.properties).toHaveProperty("session_id");
  });

  it("session_set_code requires session_id and code", () => {
    const t = serverTools.find((x) => x.function.name === "session_set_code")!;
    expect(t.function.parameters.required.sort()).toEqual(
      ["code", "session_id"].sort(),
    );
  });

  it.each(["get_blocks_img_from_code", "get_hex_file_from_code"])(
    "session-less tool %s requires only code",
    (name) => {
      const t = serverTools.find((x) => x.function.name === name)!;
      expect(t.function.parameters.required).toEqual(["code"]);
      expect(t.function.parameters.properties).not.toHaveProperty("session_id");
    },
  );

  describe("workflow guidance embedded in descriptions", () => {
    it("session_start tells the model not to stop after this call", () => {
      const t = serverTools.find((x) => x.function.name === "session_start")!;
      expect(t.function.description).toMatch(
        /continue|do not stop|proceed|follow[- ]?up/i,
      );
      expect(t.function.description).toMatch(/session_set_code|stateful/i);
    });

    it("session_get_blocks_img description tells the model to call it after producing code", () => {
      const t = serverTools.find((x) => x.function.name === "session_get_blocks_img")!;
      expect(t.function.description).toMatch(/PNG|image/i);
    });

    it("describes the empty-editor guard", () => {
      const t = serverTools.find((x) => x.function.name === "session_get_blocks_img")!;
      expect(t.function.description).toMatch(/loaded|session_set_code/i);
    });

    it("session_set_code suggests a natural follow-up tool", () => {
      const t = serverTools.find((x) => x.function.name === "session_set_code")!;
      expect(t.function.description).toMatch(/session_get_blocks_img|session_get_hex_file/);
    });
  });
});
