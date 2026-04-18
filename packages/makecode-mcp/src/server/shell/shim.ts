import {
  createMakeCodeURL,
  MakeCodeFrameDriver,
  createMakeCodeRenderBlocks,
} from "@microbit/makecode-embed/vanilla";
import { fillProjectDefaults } from "../../shared/project-defaults.js";

interface ShimApi {
  importProject(text: Record<string, string>): Promise<void>;
  saveProject(): Promise<{ text: Record<string, string> }>;
  compile(): Promise<{ name: string; hex: string }>;
  renderBlocks(code: string): Promise<string>;
}

declare global {
  interface Window {
    __mkcp: ShimApi;
  }
}

let driverInit: Promise<MakeCodeFrameDriver> | null = null;
const saveWaiters: Array<(p: { text: Record<string, string> }) => void> = [];
let downloadWaiter: ((d: { name: string; hex: string }) => void) | null = null;
let latestHeader: unknown = undefined;
let renderer: ReturnType<typeof createMakeCodeRenderBlocks> | null = null;

function getRenderer() {
  if (!renderer) {
    renderer = createMakeCodeRenderBlocks({});
    renderer.initialize();
  }
  return renderer;
}

function ensureDriver(): Promise<MakeCodeFrameDriver> {
  if (driverInit) return driverInit;
  driverInit = (async () => {
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
    const driver = new MakeCodeFrameDriver(
      {
        controllerId: "mkcp-server",
        initialProjects: async () => [{ text: fillProjectDefaults({}, "") }],
        onWorkspaceSave: (e: { project: { header?: unknown; text?: Record<string, string> } }) => {
          latestHeader = e.project?.header ?? latestHeader;
          const cbs = saveWaiters.splice(0);
          const text = e.project?.text ?? {};
          for (const cb of cbs) cb({ text });
        },
        onEditorContentLoaded: () => resolveReady(),
        onDownload: (d: { name: string; hex: string }) => {
          const cb = downloadWaiter;
          downloadWaiter = null;
          cb?.({ name: d.name, hex: d.hex });
        },
      },
      () => iframe,
    );
    driver.initialize();
    await ready;
    return driver;
  })();
  return driverInit;
}

window.__mkcp = {
  async importProject(text) {
    const driver = await ensureDriver();
    const project = {
      ...(latestHeader ? { header: latestHeader } : {}),
      text,
    } as Parameters<MakeCodeFrameDriver["importProject"]>[0]["project"];
    await driver.importProject({ project });
  },
  async saveProject() {
    const driver = await ensureDriver();
    const waiter = new Promise<{ text: Record<string, string> }>((res) => {
      saveWaiters.push(res);
    });
    if (saveWaiters.length === 1) await driver.saveProject();
    return waiter;
  },
  async compile() {
    const driver = await ensureDriver();
    const waiter = new Promise<{ name: string; hex: string }>((res) => {
      downloadWaiter = res;
    });
    await driver.compile();
    return waiter;
  },
  async renderBlocks(code) {
    const result = await getRenderer().renderBlocks({ code });
    return result.svg ?? "";
  },
};
