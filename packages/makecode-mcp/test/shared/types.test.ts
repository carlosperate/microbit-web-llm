import { describe, it, expect } from "vitest";
import { SessionError, isSessionError } from "../../src/shared/types.ts";
import type { BrowserExecutor, ServerExecutor } from "../../src/shared/types.ts";

describe("SessionError", () => {
  it("is an Error with a machine-readable code", () => {
    const err = new SessionError("missing", "call start_session first");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("missing");
    expect(err.message).toBe("call start_session first");
  });

  it("isSessionError narrows unknowns", () => {
    expect(isSessionError(new SessionError("unknown", "x"))).toBe(true);
    expect(isSessionError(new Error("x"))).toBe(false);
    expect(isSessionError({ code: "missing", message: "x" })).toBe(false);
  });

  it("accepts all three codes", () => {
    for (const code of ["missing", "unknown", "expired"] as const) {
      const e = new SessionError(code, "msg");
      expect(e.code).toBe(code);
    }
  });
});

describe("BrowserExecutor interface (type-level)", () => {
  // Stateless — one iframe per executor. Methods take no session_id and there
  // is no start/end lifecycle: the iframe itself is the session.
  it("type-checks a mock implementation without any session methods", () => {
    const mock: BrowserExecutor = {
      getCurrentCode: async () => "",
      setCode: async (_code: string) => {},
      getBlocksImage: async () => ({ pngBase64: "" }),
      getHexFile: async () => "",
      getBlocksImageFromCode: async (_code: string) => ({ pngBase64: "" }),
    };
    expect(typeof mock.setCode).toBe("function");
  });
});

describe("ServerExecutor interface (type-level)", () => {
  // Session-scoped — one MCP server can serve many clients. Stateful methods
  // take session_id to pick the right puppeteer tab.
  it("type-checks a mock implementation with full session lifecycle", () => {
    const mock: ServerExecutor = {
      startSession: async () => ({ session_id: "abc" }),
      endSession: async (_sid: string) => {},
      getCurrentCode: async (_sid: string) => "",
      setCode: async (_sid: string, _code: string) => {},
      getBlocksImage: async (_sid: string) => ({ pngBase64: "" }),
      getHexFile: async (_sid: string) => "",
      getBlocksImageFromCode: async (_code: string) => ({ pngBase64: "" }),
      getHexFileFromCode: async (_code: string) => "",
    };
    expect(typeof mock.startSession).toBe("function");
  });
});
