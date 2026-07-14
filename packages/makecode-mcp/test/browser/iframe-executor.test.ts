import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { IframeExecutor } from "../../src/browser/iframe-executor.ts";
import type { MakeCodeDriver } from "../../src/browser/driver-port.ts";

type DriverMocks = {
  [K in keyof MakeCodeDriver]: MockedFunction<MakeCodeDriver[K]>;
};

function makeDriver(): DriverMocks {
  return {
    getProject: vi.fn(async () => ({
      text: {
        "main.ts": "",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    })),
    setProject: vi.fn(async () => {}),
    compile: vi.fn(async () => ({
      name: "microbit-test",
      hex: ":020000040000FA\n:00000001FF\n",
    })),
    renderBlocksImage: vi.fn(async (_code: string) => "iVBORw0KGgo="),
  };
}

// The iframe *is* the session: no session_start / session_end, no session_id.
// One executor instance maps to one iframe and its lifetime; state lives in
// the iframe itself.
describe("IframeExecutor — stateful tools", () => {
  let driver: DriverMocks;
  let exec: IframeExecutor;
  beforeEach(() => {
    driver = makeDriver();
    exec = new IframeExecutor(driver);
  });

  it("setCode replaces main.ts in the current project", async () => {
    driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "old",
        "main.blocks": "<blocks/>",
        "pxt.json": '{"preferredEditor":"tsprj"}',
        "README.md": " ",
      },
    });
    await exec.setCode('basic.showString("hi")');
    expect(driver.setProject).toHaveBeenCalledOnce();
    const arg = driver.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe('basic.showString("hi")');
    // Blocks must be cleared so the blocks view re-decompiles from the new main.ts.
    expect(arg.text["main.blocks"]).toBe("");
    expect(arg.text["pxt.json"]).toBe('{"preferredEditor":"tsprj"}');
  });

  it("getCurrentCode returns main.ts text", async () => {
    driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "hello",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    });
    await expect(exec.getCurrentCode()).resolves.toBe("hello");
  });

  it("getBlocksImage on empty editor throws LLM-directed message", async () => {
    await expect(exec.getBlocksImage()).rejects.toThrow(
      /No code loaded in the editor\. Call session_set_code first/,
    );
    expect(driver.renderBlocksImage).not.toHaveBeenCalled();
  });

  it("getBlocksImage renders the loaded code as a PNG", async () => {
    driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "basic.forever(() => {})",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    });
    const img = await exec.getBlocksImage();
    expect(img).toEqual({ pngBase64: "iVBORw0KGgo=" });
    expect(driver.renderBlocksImage).toHaveBeenCalledWith("basic.forever(() => {})");
  });

  it("state persists across calls on the same executor", async () => {
    // Demonstrates the "iframe-is-the-session" contract: no ceremony to keep
    // state between calls — consecutive calls share the same iframe.
    await exec.setCode("first");
    driver.getProject.mockResolvedValueOnce({
      text: { "main.ts": "first", "main.blocks": "", "pxt.json": "{}", "README.md": " " },
    });
    await expect(exec.getCurrentCode()).resolves.toBe("first");
  });
});

describe("IframeExecutor — setCode local diagnostics enrichment", () => {
  const COMPILE_HINT =
    "Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again.";

  it("appends local compiler errors to decompile failures", async () => {
    const driver = makeDriver();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_HINT));
    const localDiagnostics = vi.fn(async () => [
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
    const exec = new IframeExecutor(driver, localDiagnostics);
    await expect(exec.setCode("accelermeter.x()")).rejects.toThrow(
      COMPILE_HINT +
        "\n\nCompiler errors:\nmain.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    );
    expect(localDiagnostics).toHaveBeenCalledWith("accelermeter.x()");
  });

  it("rethrows the original error when no diagnostics are found", async () => {
    const driver = makeDriver();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_HINT));
    const exec = new IframeExecutor(driver, async () => []);
    const err = await exec.setCode("x").then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toBe(COMPILE_HINT);
  });

  it("does not consult the local compiler for transport errors", async () => {
    const driver = makeDriver();
    driver.setProject.mockRejectedValueOnce(new Error("Attempted to use detached Frame"));
    const localDiagnostics = vi.fn(async () => ["should not appear"]);
    const exec = new IframeExecutor(driver, localDiagnostics);
    await expect(exec.setCode("x")).rejects.toThrow("Attempted to use detached Frame");
    expect(localDiagnostics).not.toHaveBeenCalled();
  });

  it("rethrows the original error if the diagnostics provider itself fails", async () => {
    const driver = makeDriver();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_HINT));
    const exec = new IframeExecutor(driver, async () => {
      throw new Error("compiler exploded");
    });
    await expect(exec.setCode("x")).rejects.toThrow(COMPILE_HINT);
  });
});

describe("IframeExecutor — stateless _from_code tools", () => {
  let driver: DriverMocks;
  let exec: IframeExecutor;
  beforeEach(() => {
    driver = makeDriver();
    exec = new IframeExecutor(driver);
  });

  it("getBlocksImageFromCode renders without touching editor state", async () => {
    const img = await exec.getBlocksImageFromCode("basic.showNumber(1)");
    expect(img).toEqual({ pngBase64: "iVBORw0KGgo=" });
    expect(driver.renderBlocksImage).toHaveBeenCalledWith("basic.showNumber(1)");
    expect(driver.setProject).not.toHaveBeenCalled();
    expect(driver.getProject).not.toHaveBeenCalled();
  });

});
