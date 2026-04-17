import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { IframeExecutor } from "../../src/browser/iframe-executor.ts";
import type { MakeCodeDriver } from "../../src/browser/driver-port.ts";
import { SessionError } from "../../src/shared/types.ts";

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

describe("IframeExecutor — session lifecycle", () => {
  let driver: DriverMocks;
  let exec: IframeExecutor;
  beforeEach(() => {
    driver = makeDriver();
    exec = new IframeExecutor(driver);
  });

  it("startSession returns an opaque session_id string", async () => {
    const { session_id } = await exec.startSession();
    expect(typeof session_id).toBe("string");
    expect(session_id.length).toBeGreaterThan(8);
  });

  it("starting a second session supersedes the first", async () => {
    const { session_id: first } = await exec.startSession();
    const { session_id: second } = await exec.startSession();
    expect(first).not.toBe(second);
    await expect(exec.getCurrentCode(first)).rejects.toBeInstanceOf(
      SessionError,
    );
    await expect(exec.getCurrentCode(second)).resolves.toBeDefined();
  });

  it("endSession invalidates the id", async () => {
    const { session_id } = await exec.startSession();
    await exec.endSession(session_id);
    await expect(exec.getCurrentCode(session_id)).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it.each([
    "getCurrentCode",
    "setCode",
    "getBlocksSvg",
    "getHexFile",
    "endSession",
  ] as const)("%s rejects missing session_id with SessionError(missing)", async (method) => {
    const call =
      method === "setCode"
        ? exec.setCode("", "code")
        : (exec[method] as (s: string) => Promise<unknown>)("");
    await expect(call).rejects.toMatchObject({
      name: "SessionError",
      code: "missing",
    });
  });

  it("unknown session_id yields SessionError(unknown)", async () => {
    await expect(exec.getCurrentCode("not-a-real-id")).rejects.toMatchObject({
      code: "unknown",
    });
  });
});

describe("IframeExecutor — stateful tools", () => {
  let driver: DriverMocks;
  let exec: IframeExecutor;
  let sid: string;
  beforeEach(async () => {
    driver = makeDriver();
    exec = new IframeExecutor(driver);
    ({ session_id: sid } = await exec.startSession());
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
    await exec.setCode(sid, 'basic.showString("hi")');
    expect(driver.setProject).toHaveBeenCalledOnce();
    const arg = driver.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe('basic.showString("hi")');
    expect(arg.text["main.blocks"]).toBe("<blocks/>");
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
    await expect(exec.getCurrentCode(sid)).resolves.toBe("hello");
  });

  it("getBlocksSvg on empty editor throws LLM-directed message", async () => {
    await expect(exec.getBlocksSvg(sid)).rejects.toThrow(
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
    const svg = await exec.getBlocksSvg(sid);
    expect(svg).toBe("<svg>ok</svg>");
    expect(driver.renderBlocks).toHaveBeenCalledWith("basic.forever(() => {})");
  });

  it("getHexFile compiles and base64-encodes the hex text", async () => {
    const out = await exec.getHexFile(sid);
    expect(driver.compile).toHaveBeenCalledOnce();
    const decoded = Buffer.from(out, "base64").toString("utf8");
    expect(decoded).toBe(":020000040000FA\n:00000001FF\n");
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
