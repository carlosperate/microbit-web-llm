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

describe("TabExecutor — stateless compile-failure hint", () => {
  // What PuppeteerDriver produces: the shared adapter's hint (which names
  // session_set_code, the only write tool it knows) plus appended diagnostics.
  const COMPILE_FAIL_MSG =
    "Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again." +
    "\n\nCompiler errors:\nmain.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?";

  // Pool whose stateless tab uses a caller-supplied driver, so tests can
  // program setProject failures before the executor call creates one.
  function makePoolWith(statelessDriver: DriverMocks): TabPool {
    return {
      openTab: vi.fn(async (): Promise<TabHandle> => ({
        driver: makeDriver(),
        close: vi.fn(async () => {}),
      })),
      withStatelessTab: vi.fn(
        async <T>(fn: (d: MakeCodeDriver) => Promise<T>) => fn(statelessDriver),
      ),
      dispose: vi.fn(async () => {}),
    };
  }

  it("getBlocksImageFromCode retargets the hint to its own tool name, keeping diagnostics", async () => {
    // There is no session on this path; telling the model to call
    // session_set_code would send it into a missing-session error instead
    // of just retrying this tool with fixed code.
    const d = makeDriver();
    d.setProject.mockRejectedValueOnce(new Error(COMPILE_FAIL_MSG));
    const exec = new TabExecutor(makePoolWith(d));
    const err = await exec
      .getBlocksImageFromCode("basic.showString(button)")
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("call get_blocks_img_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(err!.message).toContain(
      "Compiler errors:\nmain.ts(2,23): error TS2552",
    );
    expect(d.renderBlocksImage).not.toHaveBeenCalled();
  });

  it("getBlocksImageFromCode also retargets the pre-validation rejection message", async () => {
    // The shim adapter now rejects uncompilable code before importing; that
    // message names session_set_code too and must be retargeted the same way.
    const d = makeDriver();
    d.setProject.mockRejectedValueOnce(
      new Error(
        "The code was not loaded because it does not compile. The editor still contains the previous code. Fix the TypeScript and call session_set_code again.\n\nCompiler errors:\nmain.ts(1,1): error TS2304: Cannot find name 'x'.",
      ),
    );
    const exec = new TabExecutor(makePoolWith(d));
    const err = await exec
      .getBlocksImageFromCode("x")
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toContain("call get_blocks_img_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(err!.message).toContain("Compiler errors:");
  });

  it("getHexFileFromCode retargets the hint to its own tool name", async () => {
    const d = makeDriver();
    d.setProject.mockRejectedValueOnce(new Error(COMPILE_FAIL_MSG));
    const exec = new TabExecutor(makePoolWith(d));
    const err = await exec
      .getHexFileFromCode("basic.showString(button)")
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("call get_hex_file_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(d.compile).not.toHaveBeenCalled();
  });

  it("non-compile errors from the stateless write propagate unchanged", async () => {
    const d = makeDriver();
    d.setProject.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"));
    const exec = new TabExecutor(makePoolWith(d));
    await expect(exec.getBlocksImageFromCode("x")).rejects.toThrow(
      "net::ERR_CONNECTION_RESET",
    );
  });
});

describe("TabExecutor — dead session tab", () => {
  it("converts a detached-frame error during a session op into SessionError(expired) and closes the tab", async () => {
    // Headed mode: the user can close the editor window at any time; or Chrome
    // discards an idle tab. The next op hits a dead page — surface a clean
    // 'expired' so the model starts a new session, not the raw Puppeteer string.
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool, { reapIntervalMs: 0 });
    const { session_id } = await exec.startSession();
    handles[0].driver.getProject.mockRejectedValueOnce(
      new Error("Attempted to use detached Frame '16147B7AF484C3'"),
    );
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      name: "SessionError",
      code: "expired",
    });
    expect(handles[0].close).toHaveBeenCalledOnce();
    // The session is gone — a later use also reports expired, not unknown.
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("lets a normal tool error propagate unchanged (session stays usable)", async () => {
    const { pool, handles } = makePool();
    const exec = new TabExecutor(pool, { reapIntervalMs: 0 });
    const { session_id } = await exec.startSession();
    handles[0].driver.getProject.mockRejectedValueOnce(
      new Error("failed to compile to blocks"),
    );
    await expect(exec.getCurrentCode(session_id)).rejects.toThrow(
      /failed to compile to blocks/,
    );
    expect(handles[0].close).not.toHaveBeenCalled();
    // Session survives — a follow-up call works.
    await expect(exec.getCurrentCode(session_id)).resolves.toBeDefined();
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

describe("TabExecutor — idle session reaper", () => {
  it("closes sessions untouched for longer than idleTimeoutMs and returns SessionError(expired) on next use", async () => {
    const { pool, handles } = makePool();
    // Inject a controllable clock and disable the auto-reap interval — we
    // trigger the reaper manually so the test is deterministic without fake
    // timers and without depending on real wall-clock.
    let nowMs = 1_000_000;
    const exec = new TabExecutor(pool, {
      idleTimeoutMs: 30 * 60_000,
      reapIntervalMs: 0,
      now: () => nowMs,
    });
    const { session_id } = await exec.startSession();
    // 29 minutes — still within window.
    nowMs += 29 * 60_000;
    exec.reapIdleSessions();
    expect(handles[0].close).not.toHaveBeenCalled();
    // 31 minutes total — past the cutoff.
    nowMs += 2 * 60_000;
    exec.reapIdleSessions();
    expect(handles[0].close).toHaveBeenCalledOnce();
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      name: "SessionError",
      code: "expired",
    });
  });

  it("any successful call resets the idle timer for that session", async () => {
    const { pool, handles } = makePool();
    let nowMs = 1_000_000;
    const exec = new TabExecutor(pool, {
      idleTimeoutMs: 30 * 60_000,
      reapIntervalMs: 0,
      now: () => nowMs,
    });
    const { session_id } = await exec.startSession();
    nowMs += 29 * 60_000;
    await exec.getCurrentCode(session_id); // touch
    nowMs += 29 * 60_000; // 58 min total, but only 29 since last touch
    exec.reapIdleSessions();
    expect(handles[0].close).not.toHaveBeenCalled();
  });

  it("reaping only one of several sessions leaves the others usable", async () => {
    const { pool, handles } = makePool();
    let nowMs = 1_000_000;
    const exec = new TabExecutor(pool, {
      idleTimeoutMs: 30 * 60_000,
      reapIntervalMs: 0,
      now: () => nowMs,
    });
    const { session_id: a } = await exec.startSession();
    nowMs += 20 * 60_000;
    const { session_id: b } = await exec.startSession();
    nowMs += 15 * 60_000; // a: 35 min idle (stale), b: 15 min idle (fresh)
    exec.reapIdleSessions();
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(handles[1].close).not.toHaveBeenCalled();
    await expect(exec.getCurrentCode(a)).rejects.toMatchObject({ code: "expired" });
    await expect(exec.getCurrentCode(b)).resolves.toBeDefined();
  });

  it("idleTimeoutMs:0 disables the reaper", async () => {
    const { pool, handles } = makePool();
    let nowMs = 1_000_000;
    const exec = new TabExecutor(pool, {
      idleTimeoutMs: 0,
      reapIntervalMs: 0,
      now: () => nowMs,
    });
    const { session_id } = await exec.startSession();
    nowMs += 24 * 3_600_000; // 24 hours
    exec.reapIdleSessions();
    expect(handles[0].close).not.toHaveBeenCalled();
    await expect(exec.getCurrentCode(session_id)).resolves.toBeDefined();
  });

  it("dispose clears the background reap interval", async () => {
    vi.useFakeTimers();
    try {
      const { pool } = makePool();
      const exec = new TabExecutor(pool, {
        idleTimeoutMs: 30 * 60_000,
        reapIntervalMs: 60_000,
      });
      await exec.dispose();
      // After dispose, no timers should be pending; advancing time must not
      // schedule further reap work.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("endSession does not mark the id as expired (it's a normal close, not a reap)", async () => {
    // Distinguish "user called end" from "reaper closed it" — the former
    // should yield 'unknown' on subsequent use (LLM may have lost track),
    // the latter 'expired' (server timed it out).
    const { pool } = makePool();
    const exec = new TabExecutor(pool, { reapIntervalMs: 0 });
    const { session_id } = await exec.startSession();
    await exec.endSession(session_id);
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      code: "unknown",
    });
  });
});
