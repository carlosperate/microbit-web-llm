import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock createMakeCodeRenderBlocks before importing the adapter
const mockRenderBlocks = vi.fn(async ({ code }: { code: string }) => ({
  svg: `<svg>${code}</svg>`,
}));
const mockRenderer = {
  initialize: vi.fn(),
  dispose: vi.fn(),
  renderBlocks: mockRenderBlocks,
};
vi.mock("@microbit/makecode-embed/vanilla", () => ({
  createMakeCodeRenderBlocks: vi.fn(() => mockRenderer),
}));

import { MakeCodeFrameDriverAdapter } from "../../src/browser/frame-driver-adapter.ts";

function makeDriverStub() {
  return {
    saveProject: vi.fn(async () => {}),
    importProject: vi.fn(async () => {}),
    compile: vi.fn(async () => {}),
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

  it("initializes the blocks renderer lazily on first renderBlocks call", async () => {
    expect(mockRenderer.initialize).not.toHaveBeenCalled();
    await adapter.renderBlocks("basic.showString('hi')");
    expect(mockRenderer.initialize).toHaveBeenCalledOnce();
    // Second call reuses the same renderer instance
    await adapter.renderBlocks("basic.showString('hi')");
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

  it("renderBlocks uses createMakeCodeRenderBlocks and returns svg", async () => {
    const out = await adapter.renderBlocks("basic.showNumber(1)");
    expect(mockRenderBlocks).toHaveBeenCalledWith({ code: "basic.showNumber(1)" });
    expect(out).toBe("<svg>basic.showNumber(1)</svg>");
  });

  it("renderBlocks returns empty string when svg is undefined", async () => {
    mockRenderBlocks.mockResolvedValueOnce({});
    const out = await adapter.renderBlocks("x");
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
