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
  name: "spike",
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

  beforeEach(() => {
    vi.clearAllMocks();
    driver = makeDriverStub();
    adapter = new MakeCodeFrameDriverAdapter(driver);
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

  it("getProject caches the most recent save and returns it without triggering saveProject", async () => {
    adapter.handleWorkspaceSave({ project: { header: HEADER, text: FILES } });
    const project = await adapter.getProject();
    expect(project.text).toEqual(FILES);
    expect(driver.saveProject).not.toHaveBeenCalled();
  });

  it("setProject calls importProject with merged text and the current header", async () => {
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

    adapter.handleDownload({ name: "microbit-spike", hex: ":00000001FF\n" });
    await expect(pending).resolves.toEqual({
      name: "microbit-spike",
      hex: ":00000001FF\n",
    });
  });

  it("renderBlocksImage uses createMakeCodeRenderBlocks and returns a PNG base64", async () => {
    const out = await adapter.renderBlocksImage("basic.showNumber(1)");
    expect(mockRenderBlocks).toHaveBeenCalledWith({ code: "basic.showNumber(1)" });
    expect(out).toBe('png(<svg width="40" height="20">basic.showNumber(1)</svg>)');
  });

  it("renderBlocksImage returns empty string when svg is undefined", async () => {
    mockRenderBlocks.mockResolvedValueOnce({});
    const out = await adapter.renderBlocksImage("x");
    expect(out).toBe("");
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

  it("setProject updates the cache so an immediate getProject returns the new state", async () => {
    const newFiles = { ...FILES, "main.ts": "basic.clearScreen()" };
    await adapter.setProject({ text: newFiles });
    const project = await adapter.getProject();
    expect(project.text["main.ts"]).toBe("basic.clearScreen()");
    // No saveProject needed — the optimistic cache was hit.
    expect(driver.saveProject).not.toHaveBeenCalled();
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
    // so a follow-up set_code from the model can replace it.
    expect(driver.importProject).toHaveBeenCalledOnce();
  });

  it("workspacesave events merge into the cache instead of replacing", async () => {
    // After setProject, MakeCode may fire follow-up workspacesave events
    // carrying only the fields it just changed (e.g. main.blocks after a
    // view switch). Replacing the cache wholesale would drop the main.ts we
    // just imported and make the very next get_blocks_image throw
    // EMPTY_EDITOR_ERROR even though the editor still has the code.
    await adapter.setProject({ text: { ...FILES, "main.ts": "basic.showNumber(7)" } });
    adapter.handleWorkspaceSave({
      project: { header: HEADER, text: { "main.blocks": "<xml>new</xml>" } },
    });
    const project = await adapter.getProject();
    expect(project.text["main.ts"]).toBe("basic.showNumber(7)");
    expect(project.text["main.blocks"]).toBe("<xml>new</xml>");
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
