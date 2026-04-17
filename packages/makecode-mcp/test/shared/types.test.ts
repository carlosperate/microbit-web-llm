import { describe, it, expect } from "vitest";
import { SessionError, isSessionError } from "../../src/shared/types.ts";
import type { MakeCodeExecutor } from "../../src/shared/types.ts";

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

describe("MakeCodeExecutor interface (type-level)", () => {
  it("has one method per tool; type-checks a mock implementation", () => {
    const mock: MakeCodeExecutor = {
      startSession: async () => ({ session_id: "abc" }),
      endSession: async (_sid: string) => {},
      getCurrentCode: async (_sid: string) => "",
      setCode: async (_sid: string, _code: string) => {},
      getBlocksSvg: async (_sid: string) => "<svg/>",
      getHexFile: async (_sid: string) => "",
      getBlocksSvgFromCode: async (_code: string) => "<svg/>",
      getHexFileFromCode: async (_code: string) => "",
    };
    expect(typeof mock.startSession).toBe("function");
  });
});
