import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { TabExecutor } from "../../src/server/tab-executor.ts";
import type { TabPool, TabHandle } from "../../src/server/tab-pool.ts";
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
      name: "microbit",
      hex: ":020000040000FA\n:00000001FF\n",
    })),
    renderBlocksImage: vi.fn(async (_code: string) => "iVBORw0KGgo="),
  };
}

function makePool() {
  const handles: Array<{
    driver: DriverMocks;
    close: MockedFunction<() => Promise<void>>;
  }> = [];
  const transientDrivers: DriverMocks[] = [];
  const pool: TabPool = {
    openTab: vi.fn(async (): Promise<TabHandle> => {
      const driver = makeDriver();
      const close = vi.fn(async () => {});
      handles.push({ driver, close });
      return { driver, close };
    }),
    withTransientTab: vi.fn(async <T>(fn: (d: MakeCodeDriver) => Promise<T>) => {
      const driver = makeDriver();
      transientDrivers.push(driver);
      return fn(driver);
    }),
    renderBlocksImage: vi.fn(async (_code: string) => "iVBORw0KGgo="),
    dispose: vi.fn(async () => {}),
  };
  return { pool, handles, transientDrivers };
}

describe("TabExecutor — session lifecycle", () => {
  it("startSession allocates a tab and returns a unique id", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool);
    const { session_id: a } = await exec.startSession();
    const { session_id: b } = await exec.startSession();
    expect(a).not.toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(8);
    expect(pool.openTab).toHaveBeenCalledTimes(2);
    expect(handles).toHaveLength(2);
  });

  it("startSession forwards session_id and label to pool.openTab", async () => {
    const { pool } = makePool();
    const exec = new TabExecutor(pool);
    const { session_id } = await exec.startSession({ label: "demo" });
    expect(pool.openTab).toHaveBeenCalledWith({ sessionId: session_id, label: "demo" });
  });

  it("startSession without args still calls pool.openTab with the session_id", async () => {
    const { pool } = makePool();
    const exec = new TabExecutor(pool);
    const { session_id } = await exec.startSession();
    expect(pool.openTab).toHaveBeenCalledWith({ sessionId: session_id });
  });

  it("endSession closes the tab and invalidates the id", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool);
    const { session_id } = await exec.startSession();
    await exec.endSession(session_id);
    expect(handles[0].close).toHaveBeenCalledOnce();
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      name: "SessionError",
      code: "unknown",
    });
  });

  it("missing session_id produces SessionError(missing)", async () => {
    const { pool } = makePool();
    const exec = new TabExecutor(pool);
    await expect(exec.getCurrentCode("")).rejects.toBeInstanceOf(SessionError);
    await expect(exec.getCurrentCode("")).rejects.toMatchObject({
      code: "missing",
    });
  });

  it("unknown session_id yields SessionError(unknown)", async () => {
    const { pool } = makePool();
    const exec = new TabExecutor(pool);
    await expect(exec.getCurrentCode("nope")).rejects.toMatchObject({
      code: "unknown",
    });
  });

  it("concurrent sessions are isolated — each uses its own driver", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool);
    const { session_id: s1 } = await exec.startSession();
    const { session_id: s2 } = await exec.startSession();
    handles[0].driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "A",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    });
    handles[1].driver.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "B",
        "main.blocks": "",
        "pxt.json": "{}",
        "README.md": " ",
      },
    });
    await expect(exec.getCurrentCode(s1)).resolves.toBe("A");
    await expect(exec.getCurrentCode(s2)).resolves.toBe("B");
  });
});

describe("TabExecutor — stateful tools", () => {
  let pool: TabPool;
  let handles: Array<{ driver: DriverMocks; close: MockedFunction<() => Promise<void>> }>;
  let exec: TabExecutor;
  let sid: string;
  beforeEach(async () => {
    ({ pool, handles } = makePool());
    exec = new TabExecutor(pool);
    ({ session_id: sid } = await exec.startSession());
  });

  it("setCode replaces main.ts via that session's driver", async () => {
    const d = handles[0].driver;
    d.getProject.mockResolvedValueOnce({
      text: {
        "main.ts": "old",
        "main.blocks": "<b/>",
        "pxt.json": '{"preferredEditor":"tsprj"}',
        "README.md": " ",
      },
    });
    await exec.setCode(sid, "basic.showNumber(7)");
    expect(d.setProject).toHaveBeenCalledOnce();
    const arg = d.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe("basic.showNumber(7)");
    // main.blocks is intentionally cleared so MakeCode re-decompiles from main.ts.
    expect(arg.text["main.blocks"]).toBe("");
    expect(arg.text["pxt.json"]).toBe('{"preferredEditor":"tsprj"}');
  });

  it("getBlocksImage on empty editor throws LLM-directed message", async () => {
    await expect(exec.getBlocksImage(sid)).rejects.toThrow(
      /No code loaded in the editor\. Call session_set_code first/,
    );
    expect(handles[0].driver.renderBlocksImage).not.toHaveBeenCalled();
  });

  it("getHexFile compiles and base64-encodes", async () => {
    const out = await exec.getHexFile(sid);
    expect(handles[0].driver.compile).toHaveBeenCalledOnce();
    expect(Buffer.from(out, "base64").toString("utf8")).toBe(
      ":020000040000FA\n:00000001FF\n",
    );
  });
});

describe("TabExecutor — stateless _from_code tools", () => {
  it("getBlocksImageFromCode uses the pool's render-only path, not a session or transient tab", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool);
    const img = await exec.getBlocksImageFromCode('basic.showString("hi")');
    expect(img).toEqual({ pngBase64: "iVBORw0KGgo=" });
    expect(pool.openTab).not.toHaveBeenCalled();
    expect(pool.withTransientTab).not.toHaveBeenCalled();
    expect(pool.renderBlocksImage).toHaveBeenCalledWith(
      'basic.showString("hi")',
    );
    expect(handles).toHaveLength(0);
  });

  it("getHexFileFromCode loads code in a transient tab, compiles, returns base64", async () => {
    const { pool, transientDrivers } = makePool();
    const exec = new TabExecutor(pool);
    const out = await exec.getHexFileFromCode('basic.showString("hi")');
    expect(pool.withTransientTab).toHaveBeenCalledOnce();
    const d = transientDrivers[0];
    expect(d.setProject).toHaveBeenCalledOnce();
    const arg = d.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe('basic.showString("hi")');
    expect(arg.text["pxt.json"]).toMatch(/"preferredEditor":\s*"blocksprj"/);
    expect(d.compile).toHaveBeenCalledOnce();
    expect(Buffer.from(out, "base64").toString("utf8")).toBe(
      ":020000040000FA\n:00000001FF\n",
    );
  });
});

describe("TabExecutor — dispose", () => {
  it("dispose closes every open session tab and the pool", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool);
    await exec.startSession();
    await exec.startSession();
    await exec.dispose();
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(handles[1].close).toHaveBeenCalledOnce();
    expect(pool.dispose).toHaveBeenCalledOnce();
  });
});
