import {
  createMakeCodeURL,
  MakeCodeFrameDriver,
} from "@microbit/makecode-embed/vanilla";
import { MakeCodeFrameDriverAdapter } from "../../browser/frame-driver-adapter.js";
import { fillProjectDefaults } from "../../shared/project-defaults.js";

interface ShimApi {
  ready(): Promise<void>;
  importProject(text: Record<string, string>): Promise<void>;
  saveProject(): Promise<{ text: Record<string, string> }>;
  compile(): Promise<{ name: string; hex: string }>;
  renderBlocksImage(code: string): Promise<string>;
}

declare global {
  interface Window {
    __mkcp: ShimApi;
  }
}

// Set a meaningful OS window title from the URL params the server attaches
// when opening the session window. Chromium uses document.title as the
// window/taskbar title in headed mode.
(() => {
  const params = new URLSearchParams(location.search);
  const session = params.get("session") ?? "";
  const label = params.get("label") ?? "";
  const shortId = session ? session.slice(0, 8) : "";
  if (label && shortId) {
    document.title = `MakeCode — ${label} (${shortId})`;
  } else if (label) {
    document.title = `MakeCode — ${label}`;
  } else if (shortId) {
    document.title = `MakeCode (${shortId})`;
  }
})();

let adapterInit: Promise<MakeCodeFrameDriverAdapter> | null = null;

function ensureAdapter(): Promise<MakeCodeFrameDriverAdapter> {
  if (adapterInit) return adapterInit;
  adapterInit = (async () => {
    const iframe = document.getElementById("mk") as HTMLIFrameElement;
    iframe.src = createMakeCodeURL(
      "https://makecode.microbit.org",
      undefined,
      undefined,
      2,
      undefined,
    );
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    let adapter!: MakeCodeFrameDriverAdapter;
    const driver = new MakeCodeFrameDriver(
      {
        controllerId: "mkcp-server",
        initialProjects: async () => [{ text: fillProjectDefaults({}, "") }],
        onWorkspaceSave: (e) => adapter.handleWorkspaceSave(e),
        onEditorContentLoaded: () => resolveReady(),
        onDownload: (d) => adapter.handleDownload(d),
      },
      () => iframe,
    );
    adapter = new MakeCodeFrameDriverAdapter(driver);
    driver.initialize();
    await ready;
    return adapter;
  })();
  return adapterInit;
}

// Eagerly initialize the adapter so the MakeCode editor begins loading as soon
// as the shell page opens (especially visible in headed mode — without this the
// session tab shows a blank iframe until the first tool call).
ensureAdapter().catch(() => {});

window.__mkcp = {
  async ready() {
    await ensureAdapter();
  },
  async importProject(text) {
    const adapter = await ensureAdapter();
    await adapter.setProject({ text });
  },
  async saveProject() {
    const adapter = await ensureAdapter();
    return adapter.getProject();
  },
  async compile() {
    const adapter = await ensureAdapter();
    return adapter.compile();
  },
  async renderBlocksImage(code) {
    const adapter = await ensureAdapter();
    // scale=1 (vs the browser-target default of 2) — the MCP transport sends
    // the PNG as base64 to the LLM, where a 2× retina image is wasted bytes.
    return adapter.renderBlocksImage(code, 1);
  },
};
