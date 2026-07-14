import { describe, it, expect, vi } from "vitest";
import {
  LocalCompiler,
  wireMkcLogging,
  type CompilerEngine,
} from "../../src/browser/local-compiler.ts";
import type { CompilerDiagnostic } from "../../src/shared/compile-errors.ts";

const errorDiag = (msg: string, line = 0): CompilerDiagnostic => ({
  fileName: "main.ts",
  line,
  column: 0,
  code: 2304,
  category: 1,
  messageText: msg,
});

function engineOf(diagnostics: CompilerDiagnostic[]): CompilerEngine {
  return { compile: vi.fn(async () => ({ success: diagnostics.length === 0, diagnostics })) };
}

describe("LocalCompiler.getDiagnostics", () => {
  it("formats error diagnostics as main.ts(L,C) lines", async () => {
    const compiler = new LocalCompiler(async () =>
      engineOf([errorDiag("Cannot find name 'accelermeter'.", 4)]),
    );
    await expect(compiler.getDiagnostics("bad()")).resolves.toEqual([
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
  });

  it("filters out warnings and messages, keeping errors only", async () => {
    const compiler = new LocalCompiler(async () =>
      engineOf([
        { ...errorDiag("real error"), category: 1 },
        { ...errorDiag("a warning"), category: 0 },
        { ...errorDiag("a message"), category: 2 },
      ]),
    );
    const lines = await compiler.getDiagnostics("x");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("real error");
  });

  it("creates the engine once and reuses it across calls", async () => {
    const factory = vi.fn(async () => engineOf([]));
    const compiler = new LocalCompiler(factory);
    await compiler.getDiagnostics("a");
    await compiler.getDiagnostics("b");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("fails open (empty result) when engine init fails, and retries next call", async () => {
    const factory = vi
      .fn<() => Promise<CompilerEngine>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(engineOf([errorDiag("later")]));
    const compiler = new LocalCompiler(factory);
    await expect(compiler.getDiagnostics("x")).resolves.toEqual([]);
    // Transient failure must not wedge the compiler permanently.
    await expect(compiler.getDiagnostics("x")).resolves.toEqual([
      "main.ts(1,1): error TS2304: later",
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("forwards the project's dependencies to the engine", async () => {
    const engine: CompilerEngine = {
      compile: vi.fn(async () => ({ success: true, diagnostics: [] })),
    };
    const compiler = new LocalCompiler(async () => engine);
    await compiler.getDiagnostics("x", { core: "*", neopixel: "github:microsoft/pxt-neopixel" });
    expect(engine.compile).toHaveBeenCalledWith("x", {
      core: "*",
      neopixel: "github:microsoft/pxt-neopixel",
    });
  });

  it("fails open when a compile throws", async () => {
    const compiler = new LocalCompiler(async () => ({
      compile: async () => {
        throw new Error("worker died");
      },
    }));
    await expect(compiler.getDiagnostics("x")).resolves.toEqual([]);
  });

  it("serializes concurrent calls (single shared project state)", async () => {
    let active = 0;
    let maxActive = 0;
    const engine: CompilerEngine = {
      compile: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { success: true, diagnostics: [] };
      },
    };
    const compiler = new LocalCompiler(async () => engine);
    await Promise.all([
      compiler.getDiagnostics("a"),
      compiler.getDiagnostics("b"),
      compiler.getDiagnostics("c"),
    ]);
    expect(maxActive).toBe(1);
  });
});

describe("wireMkcLogging", () => {
  it("redirects mkc's log/error/debug into the given logger", () => {
    let captured: { log(m: string): void; error(m: string): void; debug(m: string): void } | null =
      null;
    const fakeMkc = {
      setLogging: (fns: typeof captured) => {
        captured = fns;
      },
    };
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    wireMkcLogging(fakeMkc, logger);
    expect(captured).not.toBeNull();
    captured!.log("downloading");
    captured!.error("boom");
    captured!.debug("noise");
    expect(logger.info).toHaveBeenCalledWith("downloading");
    expect(logger.error).toHaveBeenCalledWith("boom");
    expect(logger.debug).toHaveBeenCalledWith("noise");
  });
});
