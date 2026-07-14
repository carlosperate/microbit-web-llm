import { describe, it, expect } from "vitest";
import {
  COMPILE_TO_BLOCKS_RE,
  appendCompilerErrors,
  formatCompilerDiagnostic,
  type CompilerDiagnostic,
} from "../../src/shared/compile-errors.ts";

describe("COMPILE_TO_BLOCKS_RE", () => {
  it("matches the adapter's compile-hint message, case-insensitively", () => {
    expect(
      COMPILE_TO_BLOCKS_RE.test(
        "Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again.",
      ),
    ).toBe(true);
    expect(COMPILE_TO_BLOCKS_RE.test("FAILED TO COMPILE TO BLOCKS")).toBe(true);
  });

  it("does not match transport errors", () => {
    expect(COMPILE_TO_BLOCKS_RE.test("Attempted to use detached Frame")).toBe(false);
    expect(COMPILE_TO_BLOCKS_RE.test("timeout waiting for workspacesave")).toBe(false);
  });
});

describe("appendCompilerErrors", () => {
  it("appends the lines under a Compiler errors: heading", () => {
    expect(
      appendCompilerErrors("failed to compile to blocks.", [
        "main.ts(1,1): error TS2304: Cannot find name 'x'.",
        "main.ts(2,1): error TS2304: Cannot find name 'y'.",
      ]),
    ).toBe(
      "failed to compile to blocks.\n\nCompiler errors:\n" +
        "main.ts(1,1): error TS2304: Cannot find name 'x'.\n" +
        "main.ts(2,1): error TS2304: Cannot find name 'y'.",
    );
  });

  it("returns the message unchanged when there are no lines", () => {
    expect(appendCompilerErrors("msg", [])).toBe("msg");
  });
});

describe("formatCompilerDiagnostic", () => {
  it("formats a plain diagnostic with 1-based line/column", () => {
    const d: CompilerDiagnostic = {
      fileName: "main.ts",
      line: 1,
      column: 22,
      code: 2552,
      messageText: "Cannot find name 'button'. Did you mean 'Button'?",
    };
    expect(formatCompilerDiagnostic(d)).toBe(
      "main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?",
    );
  });

  it("formats a chained message on continuation lines", () => {
    const d: CompilerDiagnostic = {
      fileName: "main.ts",
      line: 0,
      column: 0,
      code: 2345,
      messageText: {
        messageText: "Argument of type 'string' is not assignable.",
        code: 2345,
        next: {
          messageText: "Type 'string' is not a 'number'.",
          code: 2322,
        },
      },
    };
    expect(formatCompilerDiagnostic(d)).toBe(
      "main.ts(1,1): error TS2345: Argument of type 'string' is not assignable.\n" +
        "  Type 'string' is not a 'number'.",
    );
  });

  it("omits the location prefix when fileName is missing", () => {
    const d: CompilerDiagnostic = { code: 1, messageText: "boom" };
    expect(formatCompilerDiagnostic(d)).toBe("error TS1: boom");
  });
});
