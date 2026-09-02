import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { SessionExecutor } from "../../src/server/session-executor.ts";
import type { TabPool } from "../../src/server/tab-pool.ts";
import type { MakeCodeDriver } from "../../src/browser/driver-port.ts";
import { SessionError } from "../../src/shared/types.ts";

type DriverMocks = {
  [K in keyof MakeCodeDriver]: MockedFunction<MakeCodeDriver[K]>;
};

const EMPTY_BLOCKS =
  '<xml xmlns="http://www.w3.org/1999/xhtml"><variables></variables></xml>';

/**
 * Stands in for the one shared editor tab: it remembers the last imported
 * project, and (like MakeCode) answers reads with a *decompiled* main.blocks
 * rather than the empty one the import cleared.
 */
function makeDriver(): DriverMocks {
  let project: { text: Record<string, string> } = {
    text: {
      "main.ts": "",
      "main.blocks": EMPTY_BLOCKS,
      "pxt.json": JSON.stringify({ name: "Untitled", preferredEditor: "blocksprj" }),
      "README.md": " ",
    },
  };
  return {
    getProject: vi.fn(async () => project),
    setProject: vi.fn(async (p) => {
      project = {
        text: { ...p.text, "main.blocks": `<xml>decompiled:${p.text["main.ts"]}</xml>` },
      };
    }),
    compile: vi.fn(async () => ({
      name: "microbit",
      hex: ":020000040000FA\n:00000001FF\n",
    })),
    renderBlocksImage: vi.fn(async (code: string) => `png:${code}`),
  };
}

/** Hold the next setProject open until released, without losing the driver's
 *  real state update (the executor commits what it reads back afterwards). */
function stallNextWrite(driver: DriverMocks) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const real = driver.setProject.getMockImplementation()!;
  driver.setProject.mockImplementationOnce(async (p) => {
    await gate;
    return real(p);
  });
  return release;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** One driver for every call: the real pool has exactly one editor tab. */
function makePool(driver: DriverMocks = makeDriver()) {
  const pool: TabPool = {
    withStatelessTab: vi.fn(async <T>(fn: (d: MakeCodeDriver) => Promise<T>) =>
      fn(driver),
    ),
    dispose: vi.fn(async () => {}),
  };
  return { pool, driver };
}

describe("SessionExecutor — session lifecycle", () => {
  it("startSession returns a unique id without opening any editor tab", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id: a } = await exec.startSession();
    const { session_id: b } = await exec.startSession();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
    // Sessions are data on the server; nothing is opened until a tool needs
    // the editor.
    expect(pool.withStatelessTab).not.toHaveBeenCalled();
    expect(exec.store.size).toBe(2);
  });

  it("startSession seeds the session with the empty MakeCode default project", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    const rec = exec.store.get(session_id)!;
    expect(rec.version).toBe(0);
    expect(rec.files["main.ts"]).toBe("");
    expect(rec.files["pxt.json"]).toMatch(/"preferredEditor":\s*"blocksprj"/);
    // Complete enough to import straight into the editor (hex on a fresh
    // session must not fail on a half-populated project).
    expect(rec.files["main.blocks"]).toBeTruthy();
    expect(rec.files["README.md"]).toBeTruthy();
  });

  it("startSession records the label", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession({ label: "demo" });
    expect(exec.store.get(session_id)!.label).toBe("demo");
  });

  it("endSession drops the session and invalidates the id", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    await exec.endSession(session_id);
    expect(exec.store.has(session_id)).toBe(false);
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      name: "SessionError",
      code: "unknown",
    });
  });

  it("missing session_id produces SessionError(missing)", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    await expect(exec.getCurrentCode("")).rejects.toBeInstanceOf(SessionError);
    await expect(exec.getCurrentCode("")).rejects.toMatchObject({ code: "missing" });
  });

  it("unknown session_id yields SessionError(unknown)", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    await expect(exec.getCurrentCode("nope")).rejects.toMatchObject({
      code: "unknown",
    });
  });
});

describe("SessionExecutor — stateful tools over the shared editor", () => {
  let pool: TabPool;
  let driver: DriverMocks;
  let exec: SessionExecutor;
  let sid: string;
  beforeEach(async () => {
    ({ pool, driver } = makePool());
    exec = new SessionExecutor(pool);
    ({ session_id: sid } = await exec.startSession());
  });

  it("getCurrentCode reads the store — no editor round-trip at all", async () => {
    await expect(exec.getCurrentCode(sid)).resolves.toBe("");
    expect(pool.withStatelessTab).not.toHaveBeenCalled();
  });

  it("setCode imports the session's own project with main.blocks cleared", async () => {
    await exec.setCode(sid, "basic.showNumber(7)");
    expect(pool.withStatelessTab).toHaveBeenCalledOnce();
    const arg = driver.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe("basic.showNumber(7)");
    // Cleared so MakeCode re-decompiles from the new main.ts.
    expect(arg.text["main.blocks"]).toBe("");
    expect(arg.text["pxt.json"]).toMatch(/blocksprj/);
  });

  it("setCode commits what the editor emitted, not what we sent", async () => {
    // The invariant the store rests on: after a write we persist the editor's
    // own save, so main.blocks is MakeCode's decompilation.
    await exec.setCode(sid, "basic.showNumber(7)");
    const rec = exec.store.get(sid)!;
    expect(rec.version).toBe(1);
    expect(rec.files["main.ts"]).toBe("basic.showNumber(7)");
    expect(rec.files["main.blocks"]).toBe("<xml>decompiled:basic.showNumber(7)</xml>");
    await expect(exec.getCurrentCode(sid)).resolves.toBe("basic.showNumber(7)");
  });

  it("setCode stores the editor's main.ts when MakeCode rewrites it", async () => {
    // The blocks round-trip can reformat the source; the session must hold the
    // editor's version so later reads and renders agree with it.
    const real = driver.setProject.getMockImplementation()!;
    driver.setProject.mockImplementationOnce(async (p) =>
      real({ text: { ...p.text, "main.ts": `// normalised\n${p.text["main.ts"]}` } }),
    );
    await exec.setCode(sid, "basic.showNumber(1)");
    await expect(exec.getCurrentCode(sid)).resolves.toBe(
      "// normalised\nbasic.showNumber(1)",
    );
  });

  it("a failed setCode leaves the stored project untouched", async () => {
    await exec.setCode(sid, "good()");
    driver.setProject.mockRejectedValueOnce(
      new Error("Code was loaded into the editor but failed to compile to blocks."),
    );
    await expect(exec.setCode(sid, "bad(")).rejects.toThrow(/failed to compile/);
    const rec = exec.store.get(sid)!;
    expect(rec.files["main.ts"]).toBe("good()");
    expect(rec.version).toBe(1);
  });

  it("sessions stay isolated even though they share one editor tab", async () => {
    const { session_id: other } = await exec.startSession();
    await exec.setCode(sid, "A()");
    await exec.setCode(other, "B()");
    // The editor now holds B, but each session reads its own committed code.
    await expect(exec.getCurrentCode(sid)).resolves.toBe("A()");
    await expect(exec.getCurrentCode(other)).resolves.toBe("B()");
    // And a later write to `sid` re-seeds from `sid`'s project, not the tab's.
    driver.setProject.mockClear();
    await exec.setCode(sid, "A2()");
    expect(driver.setProject.mock.calls[0][0].text["main.ts"]).toBe("A2()");
  });

  it("getBlocksImage renders the stored code without importing anything", async () => {
    await exec.setCode(sid, "basic.showNumber(7)");
    driver.setProject.mockClear();
    const img = await exec.getBlocksImage(sid);
    // renderBlocksImage is a standalone renderer: it takes TS, so the read
    // path never has to load the project (nor risk a decompile failure).
    expect(driver.setProject).not.toHaveBeenCalled();
    expect(driver.renderBlocksImage).toHaveBeenCalledWith("basic.showNumber(7)");
    expect(img.pngBase64).toBe("png:basic.showNumber(7)");
  });

  it("getBlocksImage on an empty session throws the LLM-directed message", async () => {
    await expect(exec.getBlocksImage(sid)).rejects.toThrow(
      /No code loaded in the editor\. Call session_set_code first/,
    );
    expect(driver.renderBlocksImage).not.toHaveBeenCalled();
  });

  it("getHexFile imports the session's project, then compiles", async () => {
    await exec.setCode(sid, "basic.showNumber(7)");
    driver.setProject.mockClear();
    const out = await exec.getHexFile(sid);
    // compile() works off the editor's loaded project, so this path *must*
    // load the session's files first.
    expect(driver.setProject).toHaveBeenCalledOnce();
    const arg = driver.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe("basic.showNumber(7)");
    // Imported as saved, blocks included, so no needless re-decompile.
    expect(arg.text["main.blocks"]).toBe("<xml>decompiled:basic.showNumber(7)</xml>");
    expect(driver.compile).toHaveBeenCalledOnce();
    expect(Buffer.from(out, "base64").toString("utf8")).toBe(
      ":020000040000FA\n:00000001FF\n",
    );
  });

  it("getHexFile works on a fresh session (default project compiles)", async () => {
    await expect(exec.getHexFile(sid)).resolves.toBeTruthy();
    expect(driver.setProject.mock.calls[0][0].text["pxt.json"]).toBeTruthy();
  });
});

describe("SessionExecutor — per-session serialisation", () => {
  it("a read cannot observe a session mid-write", async () => {
    // session_set_code takes ~2 s; small models fire session_get_blocks_img
    // right behind it. Without the per-session lock the render would run
    // against the pre-write store and either 404 the empty editor or draw
    // stale blocks.
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    const releaseWrite = stallNextWrite(driver);

    const write = exec.setCode(session_id, "basic.showNumber(7)");
    const read = exec.getBlocksImage(session_id);
    // The read must still be queued behind the write.
    expect(driver.renderBlocksImage).not.toHaveBeenCalled();
    releaseWrite();
    await write;
    const img = await read;
    expect(img.pngBase64).toBe("png:basic.showNumber(7)");
  });

  it("work on other sessions is not blocked by one session's lock", async () => {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id: slow } = await exec.startSession();
    const { session_id: fast } = await exec.startSession();
    const release = stallNextWrite(driver);
    const blocked = exec.setCode(slow, "slow()");
    await expect(exec.getCurrentCode(fast)).resolves.toBe("");
    release();
    await blocked;
  });

  it("a rejected op releases the session lock", async () => {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    driver.setProject.mockRejectedValueOnce(new Error("boom"));
    await expect(exec.setCode(session_id, "x()")).rejects.toThrow("boom");
    await expect(exec.setCode(session_id, "y()")).resolves.toBeUndefined();
  });

  it("a session ended while an op is queued reports unknown, not a crash", async () => {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    const release = stallNextWrite(driver);
    const first = exec.setCode(session_id, "a()");
    await tick(); // let the write reach the editor before ending the session
    // Attach the handler up front: the queued call rejects the moment the
    // first one releases, and an unhandled rejection would fail the run.
    const queued = exec.setCode(session_id, "b()").catch((e: unknown) => e);
    await exec.endSession(session_id);
    release();
    // The in-flight write finishes cleanly; its commit is dropped because the
    // session it belonged to is gone.
    await expect(first).resolves.toBeUndefined();
    expect(exec.store.has(session_id)).toBe(false);
    await expect(queued).resolves.toMatchObject({ code: "unknown" });
  });
});

describe("SessionExecutor — stateless _from_code tools", () => {
  it("getBlocksImageFromCode loads the code on the shared tab so TS validation applies", async () => {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const img = await exec.getBlocksImageFromCode('basic.showString("hi")');
    expect(pool.withStatelessTab).toHaveBeenCalledOnce();
    expect(driver.setProject).toHaveBeenCalledOnce();
    expect(driver.setProject.mock.calls[0][0].text["main.ts"]).toBe(
      'basic.showString("hi")',
    );
    expect(img.pngBase64).toBe('png:basic.showString("hi")');
  });

  it("getBlocksImageFromCode renders the editor's read-back main.ts, not the raw input", async () => {
    // MakeCode can rewrite main.ts on the blocks round-trip, so the preview has
    // to show what the editor ended up with.
    const { pool, driver } = makePool();
    const real = driver.setProject.getMockImplementation()!;
    driver.setProject.mockImplementationOnce(async (p) =>
      real({ text: { ...p.text, "main.ts": `// normalised\n${p.text["main.ts"]}` } }),
    );
    const exec = new SessionExecutor(pool);
    const img = await exec.getBlocksImageFromCode("basic.showNumber(1)");
    expect(img.pngBase64).toBe("png:// normalised\nbasic.showNumber(1)");
  });

  it("getBlocksImageFromCode leaves no session state behind", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    await exec.getBlocksImageFromCode('basic.showString("hi")');
    expect(exec.store.size).toBe(0);
  });

  it("getHexFileFromCode loads code on the shared tab, compiles, returns base64", async () => {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool);
    const out = await exec.getHexFileFromCode('basic.showString("hi")');
    expect(pool.withStatelessTab).toHaveBeenCalledOnce();
    expect(driver.setProject).toHaveBeenCalledOnce();
    const arg = driver.setProject.mock.calls[0][0];
    expect(arg.text["main.ts"]).toBe('basic.showString("hi")');
    expect(arg.text["pxt.json"]).toMatch(/"preferredEditor":\s*"blocksprj"/);
    expect(driver.compile).toHaveBeenCalledOnce();
    expect(Buffer.from(out, "base64").toString("utf8")).toBe(
      ":020000040000FA\n:00000001FF\n",
    );
  });

  it("a _from_code call cannot clobber a live session's code", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    await exec.setCode(session_id, "mine()");
    await exec.getBlocksImageFromCode("someone_elses()");
    await expect(exec.getCurrentCode(session_id)).resolves.toBe("mine()");
  });
});

describe("SessionExecutor — stateless compile-failure hint", () => {
  // What PuppeteerDriver produces: the shared adapter's hint (which names
  // session_set_code, the only write tool it knows) plus appended diagnostics.
  const COMPILE_FAIL_MSG =
    "Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again." +
    "\n\nCompiler errors:\nmain.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?";

  it("getBlocksImageFromCode retargets the hint to its own tool name, keeping diagnostics", async () => {
    // There is no session on this path; telling the model to call
    // session_set_code would send it into a missing-session error instead
    // of just retrying this tool with fixed code.
    const { pool, driver } = makePool();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_FAIL_MSG));
    const exec = new SessionExecutor(pool);
    const err = await exec
      .getBlocksImageFromCode("basic.showString(button)")
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("call get_blocks_img_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(err!.message).toContain("Compiler errors:\nmain.ts(2,23): error TS2552");
    expect(driver.renderBlocksImage).not.toHaveBeenCalled();
  });

  it("getBlocksImageFromCode also retargets the pre-validation rejection message", async () => {
    // The shim adapter now rejects uncompilable code before importing; that
    // message names session_set_code too and must be retargeted the same way.
    const { pool, driver } = makePool();
    driver.setProject.mockRejectedValueOnce(
      new Error(
        "The code was not loaded because it does not compile. The editor still contains the previous code. Fix the TypeScript and call session_set_code again.\n\nCompiler errors:\nmain.ts(1,1): error TS2304: Cannot find name 'x'.",
      ),
    );
    const exec = new SessionExecutor(pool);
    const err = await exec
      .getBlocksImageFromCode("x")
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toContain("call get_blocks_img_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(err!.message).toContain("Compiler errors:");
  });

  it("getHexFileFromCode retargets the hint to its own tool name", async () => {
    const { pool, driver } = makePool();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_FAIL_MSG));
    const exec = new SessionExecutor(pool);
    const err = await exec
      .getHexFileFromCode("basic.showString(button)")
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("call get_hex_file_from_code again");
    expect(err!.message).not.toContain("session_set_code");
    expect(driver.compile).not.toHaveBeenCalled();
  });

  it("session_set_code keeps the hint pointed at itself", async () => {
    const { pool, driver } = makePool();
    driver.setProject.mockRejectedValueOnce(new Error(COMPILE_FAIL_MSG));
    const exec = new SessionExecutor(pool);
    const { session_id } = await exec.startSession();
    await expect(exec.setCode(session_id, "bad(")).rejects.toThrow(
      /call session_set_code again/,
    );
  });

  it("non-compile errors from the stateless write propagate unchanged", async () => {
    const { pool, driver } = makePool();
    driver.setProject.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"));
    const exec = new SessionExecutor(pool);
    await expect(exec.getBlocksImageFromCode("x")).rejects.toThrow(
      "net::ERR_CONNECTION_RESET",
    );
  });
});

describe("SessionExecutor — dispose", () => {
  it("dispose drops every session and disposes the pool", async () => {
    const { pool } = makePool();
    const exec = new SessionExecutor(pool);
    await exec.startSession();
    await exec.startSession();
    await exec.dispose();
    expect(exec.store.size).toBe(0);
    expect(pool.dispose).toHaveBeenCalledOnce();
  });
});

describe("SessionExecutor — idle session reaper", () => {
  function makeReapable(nowRef: { ms: number }) {
    const { pool, driver } = makePool();
    const exec = new SessionExecutor(pool, {
      idleTimeoutMs: 30 * 60_000,
      reapIntervalMs: 0,
      now: () => nowRef.ms,
    });
    return { pool, driver, exec };
  }

  it("drops sessions untouched for longer than idleTimeoutMs and reports expired", async () => {
    const nowRef = { ms: 1_000_000 };
    const { exec } = makeReapable(nowRef);
    const { session_id } = await exec.startSession();
    nowRef.ms += 29 * 60_000;
    exec.reapIdleSessions();
    expect(exec.store.has(session_id)).toBe(true);
    nowRef.ms += 2 * 60_000; // 31 min idle
    exec.reapIdleSessions();
    expect(exec.store.has(session_id)).toBe(false);
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      name: "SessionError",
      code: "expired",
    });
  });

  it("any successful call resets the idle timer for that session", async () => {
    const nowRef = { ms: 1_000_000 };
    const { exec } = makeReapable(nowRef);
    const { session_id } = await exec.startSession();
    nowRef.ms += 29 * 60_000;
    await exec.getCurrentCode(session_id); // touch
    nowRef.ms += 29 * 60_000; // 58 min total, but only 29 since last touch
    exec.reapIdleSessions();
    expect(exec.store.has(session_id)).toBe(true);
  });

  it("reaping one session leaves the others usable", async () => {
    const nowRef = { ms: 1_000_000 };
    const { exec } = makeReapable(nowRef);
    const { session_id: a } = await exec.startSession();
    nowRef.ms += 20 * 60_000;
    const { session_id: b } = await exec.startSession();
    nowRef.ms += 15 * 60_000; // a: 35 min idle, b: 15 min
    exec.reapIdleSessions();
    await expect(exec.getCurrentCode(a)).rejects.toMatchObject({ code: "expired" });
    await expect(exec.getCurrentCode(b)).resolves.toBe("");
  });

  it("idleTimeoutMs:0 disables the reaper", async () => {
    const nowRef = { ms: 1_000_000 };
    const { pool } = makePool();
    const exec = new SessionExecutor(pool, {
      idleTimeoutMs: 0,
      reapIntervalMs: 0,
      now: () => nowRef.ms,
    });
    const { session_id } = await exec.startSession();
    nowRef.ms += 24 * 3_600_000;
    exec.reapIdleSessions();
    await expect(exec.getCurrentCode(session_id)).resolves.toBe("");
  });

  it("dispose clears the background reap interval", async () => {
    vi.useFakeTimers();
    try {
      const { pool } = makePool();
      const exec = new SessionExecutor(pool, {
        idleTimeoutMs: 30 * 60_000,
        reapIntervalMs: 60_000,
      });
      await exec.dispose();
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
    const exec = new SessionExecutor(pool, { reapIntervalMs: 0 });
    const { session_id } = await exec.startSession();
    await exec.endSession(session_id);
    await expect(exec.getCurrentCode(session_id)).rejects.toMatchObject({
      code: "unknown",
    });
  });
});
