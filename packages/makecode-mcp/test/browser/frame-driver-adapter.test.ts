import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock createMakeCodeRenderBlocks before importing the adapter
const mockRenderBlocks = vi.fn(async ({ code }: { code: string }) => ({
  svg: `<svg width="40" height="20">${code}</svg>`,
}));
const mockRenderer = {
  initialize: vi.fn(),
  dispose: vi.fn(),
  renderBlocks: mockRenderBlocks,
};
vi.mock("@microbit/makecode-embed/vanilla", () => ({
  createMakeCodeRenderBlocks: vi.fn(() => mockRenderer),
}));

// Mock the canvas-based SVG→PNG helper so this test can stay in jsdom.
vi.mock("../../src/shared/svg-to-png.ts", () => ({
  svgToPngBase64: vi.fn(async (svg: string) => `png(${svg})`),
}));

import { MakeCodeFrameDriverAdapter } from "../../src/browser/frame-driver-adapter.ts";

function makeDriverStub() {
  return {
    saveProject: vi.fn(async () => {}),
    importProject: vi.fn(async () => {}),
    compile: vi.fn(async () => {}),
    switchBlocks: vi.fn(async () => {}),
  };
}

const HEADER = {
  id: "hdr-1",
  target: "microbit",
  targetVersion: "8.0.21",
  name: "test-project",
  meta: {},
  editor: "tsprj",
  pubId: "",
  pubCurrent: false,
  _rev: null,
  recentUse: 0,
  modificationTime: 0,
};

const FILES = {
  "main.ts": 'basic.showString("hi")',
  "main.blocks": "<xml/>",
  "pxt.json": '{"preferredEditor":"tsprj"}',
  "README.md": " ",
};

describe("MakeCodeFrameDriverAdapter", () => {
  let driver: ReturnType<typeof makeDriverStub>;
  let adapter: MakeCodeFrameDriverAdapter;

  // setProject now awaits a post-switchBlocks workspacesave to confirm
  // decompile actually happened (MakeCode replies success:true even when it
  // silently falls back to JS view). Tests that exercise the happy path
  // schedule a synthetic post-switch save here so they don't hit the 5 s
  // timeout. Tests that want to exercise the timeout itself override
  // driver.switchBlocks themselves.
  function autoConfirmDecompile() {
    let lastText: Record<string, string> | undefined;
    driver.importProject.mockImplementation(
      async (opts: { project: { text?: Record<string, string> } }) => {
        lastText = opts.project.text;
      },
    );
    driver.switchBlocks.mockImplementation(async () => {
      setTimeout(
        () =>
          adapter.handleWorkspaceSave({
            project: {
              header: HEADER,
              text: lastText ?? { "main.ts": "any-non-empty" },
            },
          }),
        0,
      );
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    driver = makeDriverStub();
    adapter = new MakeCodeFrameDriverAdapter(driver);
    autoConfirmDecompile();
  });

  it("initializes the blocks renderer lazily on first renderBlocksImage call", async () => {
    expect(mockRenderer.initialize).not.toHaveBeenCalled();
    await adapter.renderBlocksImage("basic.showString('hi')");
    expect(mockRenderer.initialize).toHaveBeenCalledOnce();
    // Second call reuses the same renderer instance
    await adapter.renderBlocksImage("basic.showString('hi')");
    expect(mockRenderer.initialize).toHaveBeenCalledOnce();
  });

  it("getProject triggers saveProject and resolves with the next save event", async () => {
    const pending = adapter.getProject();
    await Promise.resolve();
    expect(driver.saveProject).toHaveBeenCalledOnce();

    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    const project = await pending;
    expect(project.text).toEqual(FILES);
  });

  it("getProject always issues saveProject (no cached short-circuit)", async () => {
    // The adapter no longer caches the last save — every read is a fresh
    // workspacesave round-trip so user/editor edits between turns aren't
    // hidden behind stale state.
    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    const pending = adapter.getProject();
    await Promise.resolve();
    expect(driver.saveProject).toHaveBeenCalledOnce();
    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    await expect(pending).resolves.toEqual({ text: FILES });
  });

  it("setProject calls importProject with the imported text and the current header", async () => {
    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    await adapter.setProject({ text: { ...FILES, "main.ts": "new code" } });
    expect(driver.importProject).toHaveBeenCalledOnce();
    const arg = driver.importProject.mock.calls[0][0];
    expect(arg.project.header).toBe(HEADER);
    expect(arg.project.text["main.ts"]).toBe("new code");
    expect(arg.project.text["main.blocks"]).toBe("<xml/>");
  });

  it("setProject without a known header imports just the text and lets MakeCode create a header", async () => {
    await adapter.setProject({ text: FILES });
    const arg = driver.importProject.mock.calls[0][0];
    expect(arg.project.text).toEqual(FILES);
    expect(arg.project.header).toBeUndefined();
  });

  it("compile awaits the next onDownload event", async () => {
    const pending = adapter.compile();
    await Promise.resolve();
    expect(driver.compile).toHaveBeenCalledOnce();

    adapter.handleDownload({ name: "microbit-test", hex: ":00000001FF\n" });
    await expect(pending).resolves.toEqual({
      name: "microbit-test",
      hex: ":00000001FF\n",
    });
  });

  it("renderBlocksImage uses createMakeCodeRenderBlocks and returns a PNG base64", async () => {
    const out = await adapter.renderBlocksImage("basic.showNumber(1)");
    expect(mockRenderBlocks).toHaveBeenCalledWith({ code: "basic.showNumber(1)" });
    expect(out).toBe('png(<svg width="40" height="20">basic.showNumber(1)</svg>)');
  });

  it("renderBlocksImage throws when makecode-embed can't decompile the TS (was silently returning '' before)", async () => {
    // Silent empty PNG hid the failure from the model — `get_blocks_img_from_code`
    // would resolve with a 0-byte image and isError:false. Surfacing as a
    // throw lets MCP's safe() wrapper return isError:true with an actionable
    // message, matching what session_set_code already does on decompile fail.
    mockRenderBlocks.mockResolvedValueOnce({});
    await expect(adapter.renderBlocksImage("x")).rejects.toThrow(
      /could not be compiled into blocks/i,
    );
  });

  it("renderBlocksImage forwards the optional scale to svgToPngBase64", async () => {
    const { svgToPngBase64 } = await import("../../src/shared/svg-to-png.ts");
    await adapter.renderBlocksImage("basic.showNumber(1)", 1);
    expect(svgToPngBase64).toHaveBeenLastCalledWith(
      '<svg width="40" height="20">basic.showNumber(1)</svg>',
      1,
    );
  });

  it("renderBlocksImage without scale defaults to undefined so svgToPngBase64 uses its own default", async () => {
    const { svgToPngBase64 } = await import("../../src/shared/svg-to-png.ts");
    await adapter.renderBlocksImage("basic.showNumber(2)");
    expect(svgToPngBase64).toHaveBeenLastCalledWith(
      '<svg width="40" height="20">basic.showNumber(2)</svg>',
    );
  });

  it("concurrent getProject calls both resolve from a single saveProject call", async () => {
    // Neither call has a cache — both must wait for the save event.
    const p1 = adapter.getProject();
    const p2 = adapter.getProject();
    await Promise.resolve();
    // Only one saveProject should have been triggered.
    expect(driver.saveProject).toHaveBeenCalledOnce();

    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toEqual(FILES);
    expect(r2.text).toEqual(FILES);
  });

  it("header-only workspaceSave does not drain pending getProject waiters", async () => {
    // MakeCode fires header-only saves after internal triggers (e.g. importProject).
    // A waiter on saveProject() must not resolve with {} from such an event.
    const pending = adapter.getProject();
    await Promise.resolve();
    expect(driver.saveProject).toHaveBeenCalledOnce();

    // Header-only save: must be ignored by the waiter.
    adapter.handleWorkspaceSave({ project: { header: HEADER } });
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Real save with text drains the waiter.
    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    await expect(pending).resolves.toEqual({ text: FILES });
  });

  it("setProject throws when switchBlocks rejects so the LLM can self-correct", async () => {
    driver.switchBlocks.mockRejectedValueOnce(new Error("decompile failed: unsupported syntax"));
    await expect(
      adapter.setProject({ text: { ...FILES, "main.ts": "this is not valid TS" } }),
    ).rejects.toThrow(/loaded.*compile to blocks.*decompile failed: unsupported syntax/i);
    // The import itself succeeded — the optimistic cache reflects the new code
    // so a follow-up session_set_code from the model can replace it.
    expect(driver.importProject).toHaveBeenCalledOnce();
  });

  it("setProject also rewraps a 'Cannot convert to blocks'-style rejection so the model knows to fix the TS", async () => {
    // This is the common failure: model emits invalid TS, MakeCode imports it
    // but can't switch to blocks. The model needs an actionable hint or it
    // proceeds to session_get_blocks_img and confuses itself with a stale view.
    driver.switchBlocks.mockRejectedValueOnce(new Error("Cannot convert to blocks"));
    await expect(
      adapter.setProject({ text: { ...FILES, "main.ts": "broken();" } }),
    ).rejects.toThrow(/compile to blocks.*Cannot convert to blocks.*session_set_code/i);
  });

  it("setProject throws when MakeCode silently falls back to JS view (no post-switch workspacesave within timeout)", async () => {
    // The common decompile-failure path: MakeCode replies success:true to
    // switchblocks but shows an in-iframe "Cannot convert to blocks" modal
    // and stops emitting workspacesave events. Time-boxing the wait turns
    // that silence into a recoverable error for the model.
    vi.useFakeTimers();
    try {
      // No autoConfirmDecompile this time — switchBlocks resolves but no save fires.
      driver.switchBlocks.mockImplementation(async () => {});
      const pending = adapter.setProject({
        text: { ...FILES, "main.ts": "not actually decompilable" },
      });
      const settled = pending.catch((e) => e);
      // Let the import + switchBlocks promises resolve before advancing timers.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /failed to compile to blocks.*session_set_code/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("setProject skips the post-switch wait for empty TS (no false-positive on initial blank import)", async () => {
    // The blank-project bootstrap path imports an empty main.ts and shouldn't
    // be penalised by the decompile-confirm timer.
    driver.switchBlocks.mockImplementation(async () => {});
    await expect(adapter.setProject({ text: { ...FILES, "main.ts": "" } })).resolves
      .toBeUndefined();
    expect(driver.switchBlocks).toHaveBeenCalledOnce();
  });

  it("setProject lets a transient switchBlocks error propagate unwrapped (no misleading 'fix the TypeScript' hint)", async () => {
    // Transport-level rejection from makecode-embed (generic "not successful")
    // is not a decompile failure — rewrapping it as "Fix the TypeScript" would
    // send the model on a wild goose chase modifying perfectly valid code.
    const transient = new Error("MakeCode response was not successful with no error specified");
    driver.switchBlocks.mockRejectedValueOnce(transient);
    await expect(
      adapter.setProject({ text: { ...FILES, "main.ts": 'basic.showNumber(1)' } }),
    ).rejects.toBe(transient);
  });

  it("compile rejects with a timeout error if no download event arrives in 120s", async () => {
    vi.useFakeTimers();
    try {
      const pending = adapter.compile();
      // Swallow the eventual rejection so an unhandled-rejection warning doesn't trip vitest.
      const settled = pending.catch((e) => e);
      await Promise.resolve();
      expect(driver.compile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/Compile timed out after 120s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("compile is recoverable after a timeout — the next compile starts cleanly", async () => {
    vi.useFakeTimers();
    try {
      const first = adapter.compile().catch((e) => e);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      await first;
      // A late onDownload from the timed-out compile must not slip into the next one.
      adapter.handleDownload({ name: "stale", hex: ":STALE\n" });
      const second = adapter.compile();
      await Promise.resolve();
      adapter.handleDownload({ name: "fresh", hex: ":FRESH\n" });
      await expect(second).resolves.toEqual({ name: "fresh", hex: ":FRESH\n" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("compile rejects a second concurrent call with a clear error", async () => {
    // First compile is in flight (awaiting download event).
    const first = adapter.compile();
    await Promise.resolve();
    // Second compile arrives before the first resolves.
    await expect(adapter.compile()).rejects.toThrow(/already in progress/);
    // Resolve the first.
    adapter.handleDownload({ name: "microbit", hex: ":00000001FF\n" });
    await expect(first).resolves.toMatchObject({ hex: ":00000001FF\n" });
  });
});
