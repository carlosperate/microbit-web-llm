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
  // Mirror real adapter behaviour: a successful setProject is observable via
  // the next getProject (in production it round-trips via MakeCode; here we
  // just remember the last project so reads after writes see the new state).
  // Initial state mirrors what a freshly-loaded MakeCode editor reports:
  // pxt.json carries preferredEditor:blocksprj, main.blocks is the empty
  // <variables/> stub, main.ts is empty.
  let project: { text: Record<string, string> } = {
    text: {
      "main.ts": "",
      "main.blocks": '<xml xmlns="http://www.w3.org/1999/xhtml"><variables></variables></xml>',
      "pxt.json": JSON.stringify({ name: "Untitled", preferredEditor: "blocksprj" }),
      "README.md": " ",
    },
  };
  return {
    getProject: vi.fn(async () => project),
    setProject: vi.fn(async (p) => {
      project = { text: { ...p.text } };
    }),
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
  const statelessDrivers: DriverMocks[] = [];
  const pool: TabPool = {
    openTab: vi.fn(async (): Promise<TabHandle> => {
      const driver = makeDriver();
      const close = vi.fn(async () => {});
      handles.push({ driver, close });
      return { driver, close };
    }),
    withStatelessTab: vi.fn(async <T>(fn: (d: MakeCodeDriver) => Promise<T>) => {
      const driver = makeDriver();
      statelessDrivers.push(driver);
      return fn(driver);
    }),
    dispose: vi.fn(async () => {}),
  };
  return { pool, handles, statelessDrivers };
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
  it("getBlocksImageFromCode goes through the stateless tab so editor-side TS validation applies", async () => {
    // Previously this routed through a render-only tab with no editor, so TS
    // that didn't compile silently produced a "raw text" fallback PNG. The
    // stateless-tab path uses the same setProject + decompile-confirm flow as
    // session_set_code, so a bad TS throw bubbles up here too.
    const { pool, statelessDrivers, handles } = makePool();
    statelessDrivers; // ensures the lazy capture is set up before we read it
    const exec = new TabExecutor(pool);
    // Make renderBlocksImage return code-specific bytes so we can confirm the
    // executor reads main.ts back and pipes it through the driver renderer.
    const img = await exec.getBlocksImageFromCode('basic.showString("hi")');
    expect(pool.withStatelessTab).toHaveBeenCalledOnce();
    expect(pool.openTab).not.toHaveBeenCalled();
    expect(handles).toHaveLength(0);
    const d = statelessDrivers[0];
    // setProject validates the TS via the editor's decompile-confirm flow.
    expect(d.setProject).toHaveBeenCalledOnce();
    expect(d.setProject.mock.calls[0][0].text["main.ts"]).toBe(
      'basic.showString("hi")',
    );
    // Then the executor reads main.ts back and renders it.
    expect(d.renderBlocksImage).toHaveBeenCalled();
    expect(img.pngBase64).toBe("iVBORw0KGgo=");
  });

  it("getHexFileFromCode loads code on the stateless tab, compiles, returns base64", async () => {
    const { pool, statelessDrivers } = makePool();
    const exec = new TabExecutor(pool);
    const out = await exec.getHexFileFromCode('basic.showString("hi")');
    expect(pool.withStatelessTab).toHaveBeenCalledOnce();
    const d = statelessDrivers[0];
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
