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
      name: "microbit-spike",
      hex: ":020000040000FA\n:00000001FF\n",
    })),
    renderBlocks: vi.fn(async (_code: string) => "<svg>ok</svg>"),
  };
}

// The iframe *is* the session: no start_session / end_session, no session_id.
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

  it("getBlocksSvg on empty editor throws LLM-directed message", async () => {
    await expect(exec.getBlocksSvg()).rejects.toThrow(
      /No code loaded in the editor\. Call set_code first/,
    );
    expect(driver.renderBlocks).not.toHaveBeenCalled();
  });

  it("getBlocksSvg renders the loaded code", async () => {
    driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "basic.forever(() => {})",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    });
    const svg = await exec.getBlocksSvg();
    expect(svg).toBe("<svg>ok</svg>");
    expect(driver.renderBlocks).toHaveBeenCalledWith("basic.forever(() => {})");
  });

  it("getHexFile compiles and base64-encodes the hex text", async () => {
    const out = await exec.getHexFile();
    expect(driver.compile).toHaveBeenCalledOnce();
    const decoded = Buffer.from(out, "base64").toString("utf8");
    expect(decoded).toBe(":020000040000FA\n:00000001FF\n");
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

describe("IframeExecutor — stateless _from_code tools", () => {
  let driver: DriverMocks;
  let exec: IframeExecutor;
  beforeEach(() => {
    driver = makeDriver();
    exec = new IframeExecutor(driver);
  });

  it("getBlocksSvgFromCode renders without touching editor state", async () => {
    const svg = await exec.getBlocksSvgFromCode("basic.showNumber(1)");
    expect(svg).toBe("<svg>ok</svg>");
    expect(driver.renderBlocks).toHaveBeenCalledWith("basic.showNumber(1)");
    expect(driver.setProject).not.toHaveBeenCalled();
    expect(driver.getProject).not.toHaveBeenCalled();
  });

  it("getHexFileFromCode is not supported on the browser target", async () => {
    await expect(exec.getHexFileFromCode("x")).rejects.toThrow(
      /not supported on the browser target/,
    );
  });
});
