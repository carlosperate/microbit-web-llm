import { describe, it, expect } from "vitest";
import {
  browserTools,
  browserToolNames,
  serverTools,
  serverToolNames,
} from "../../src/shared/tools.ts";

describe("browserTools", () => {
  // The browser target exposes the iframe directly as the session, so the
  // tool list does not include start_session / end_session and no tool
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
        "get_current_code",
        "set_code",
        "get_blocks_image",
        "get_hex_file",
        "get_blocks_image_from_code",
      ].sort(),
    );
  });

  it("browserToolNames matches the browserTools array", () => {
    expect(browserToolNames.sort()).toEqual(
      browserTools.map((t) => t.function.name).sort(),
    );
  });

  it("does NOT include start_session or end_session", () => {
    const names = browserTools.map((t) => t.function.name);
    expect(names).not.toContain("start_session");
    expect(names).not.toContain("end_session");
  });

  it("no browser tool takes a session_id parameter", () => {
    for (const tool of browserTools) {
      expect(tool.function.parameters.properties).not.toHaveProperty("session_id");
      expect(tool.function.parameters.required).not.toContain("session_id");
    }
  });

  it.each(["get_current_code", "get_blocks_image", "get_hex_file"])(
    "stateful tool %s takes no arguments",
    (name) => {
      const t = browserTools.find((x) => x.function.name === name)!;
      expect(t.function.parameters.required).toEqual([]);
      expect(Object.keys(t.function.parameters.properties)).toEqual([]);
    },
  );

  it("set_code requires only `code`", () => {
    const t = browserTools.find((x) => x.function.name === "set_code")!;
    expect(t.function.parameters.required).toEqual(["code"]);
    expect(t.function.parameters.properties).toHaveProperty("code");
    expect(t.function.parameters.properties).not.toHaveProperty("session_id");
  });

  it("stateless tool get_blocks_image_from_code requires only `code`", () => {
    const t = browserTools.find(
      (x) => x.function.name === "get_blocks_image_from_code",
    )!;
    expect(t.function.parameters.required).toEqual(["code"]);
    expect(t.function.parameters.properties).toHaveProperty("code");
    expect(t.function.parameters.properties).not.toHaveProperty("session_id");
  });

  it("set_code description hints at natural follow-ups", () => {
    const t = browserTools.find((x) => x.function.name === "set_code")!;
    expect(t.function.description).toMatch(/get_blocks_image|get_hex_file/);
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
        "start_session",
        "end_session",
        "get_current_code",
        "set_code",
        "get_blocks_image",
        "get_hex_file",
        "get_blocks_image_from_code",
        "get_hex_file_from_code",
      ].sort(),
    );
  });

  it("serverToolNames matches the serverTools array", () => {
    expect(serverToolNames.sort()).toEqual(
      serverTools.map((t) => t.function.name).sort(),
    );
  });

  it("start_session takes no required args", () => {
    const t = serverTools.find((x) => x.function.name === "start_session")!;
    expect(t.function.parameters.required).toEqual([]);
  });

  it("start_session accepts an optional label", () => {
    const t = serverTools.find((x) => x.function.name === "start_session")!;
    expect(t.function.parameters.properties).toHaveProperty("label");
    expect(t.function.parameters.properties.label.type).toBe("string");
    expect(t.function.parameters.required).not.toContain("label");
  });

  it.each([
    "end_session",
    "get_current_code",
    "get_blocks_image",
    "get_hex_file",
  ])("stateful tool %s requires session_id only", (name) => {
    const t = serverTools.find((x) => x.function.name === name)!;
    expect(t.function.parameters.required).toEqual(["session_id"]);
    expect(t.function.parameters.properties).toHaveProperty("session_id");
  });

  it("set_code requires session_id and code", () => {
    const t = serverTools.find((x) => x.function.name === "set_code")!;
    expect(t.function.parameters.required.sort()).toEqual(
      ["code", "session_id"].sort(),
    );
  });

  it.each(["get_blocks_image_from_code", "get_hex_file_from_code"])(
    "session-less tool %s requires only code",
    (name) => {
      const t = serverTools.find((x) => x.function.name === name)!;
      expect(t.function.parameters.required).toEqual(["code"]);
      expect(t.function.parameters.properties).not.toHaveProperty("session_id");
    },
  );

  describe("workflow guidance embedded in descriptions", () => {
    it("start_session tells the model not to stop after this call", () => {
      const t = serverTools.find((x) => x.function.name === "start_session")!;
      expect(t.function.description).toMatch(
        /continue|do not stop|proceed|follow[- ]?up/i,
      );
      expect(t.function.description).toMatch(/set_code|stateful/i);
    });

    it("get_blocks_image description tells the model to call it after producing code", () => {
      const t = serverTools.find((x) => x.function.name === "get_blocks_image")!;
      expect(t.function.description).toMatch(/PNG|image/i);
    });

    it("describes the empty-editor guard", () => {
      const t = serverTools.find((x) => x.function.name === "get_blocks_image")!;
      expect(t.function.description).toMatch(/loaded|set_code/i);
    });

    it("set_code suggests a natural follow-up tool", () => {
      const t = serverTools.find((x) => x.function.name === "set_code")!;
      expect(t.function.description).toMatch(/get_blocks_image|get_hex_file/);
    });
  });
});
