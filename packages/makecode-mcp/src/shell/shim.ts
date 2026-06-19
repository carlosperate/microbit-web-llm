import {
  createMakeCodeURL,
  MakeCodeFrameDriver,
} from "@microbit/makecode-embed/vanilla";
import { MakeCodeFrameDriverAdapter } from "../browser/frame-driver-adapter.js";
import { lazyRetry } from "../shared/lazy-retry.js";
import { fillProjectDefaults } from "../shared/project-defaults.js";

// Tagged-union return shape for every page-RPC call. Surfaces page-side
// failures as data rather than letting them traverse `page.evaluate` as
// exceptions — Puppeteer otherwise appends a browser stack frame to the
// thrown message which leaks all the way to the MCP client. The driver
// (src/server/puppeteer-driver.ts) translates `{ ok: false }` back into a
// plain `throw new Error(...)` on the Node side.
type ShimResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface ShimApi {
  ready(): Promise<void>;
  importProject(text: Record<string, string>): Promise<ShimResult<null>>;
  saveProject(): Promise<ShimResult<{ text: Record<string, string> }>>;
  compile(): Promise<ShimResult<{ name: string; hex: string }>>;
  renderBlocksImage(code: string): Promise<ShimResult<string>>;
}

async function asResult<T>(fn: () => Promise<T>): Promise<ShimResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

// lazyRetry: a failed first init clears the cache so the next __mkcp call
// retries instead of inheriting the rejection forever.
const ensureAdapter = lazyRetry<MakeCodeFrameDriverAdapter>(async () => {
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
});

// Eagerly initialize the adapter so the MakeCode editor begins loading as soon
// as the shell page opens (especially visible in headed mode — without this the
// session tab shows a blank iframe until the first tool call).
ensureAdapter().catch(() => {});

window.__mkcp = {
  async ready() {
    await ensureAdapter();
  },
  importProject: (text) =>
    asResult(async () => {
      const adapter = await ensureAdapter();
      await adapter.setProject({ text });
      return null;
    }),
  saveProject: () =>
    asResult(async () => {
      const adapter = await ensureAdapter();
      return adapter.getProject();
    }),
  compile: () =>
    asResult(async () => {
      const adapter = await ensureAdapter();
      return adapter.compile();
    }),
  renderBlocksImage: (code) =>
    asResult(async () => {
      const adapter = await ensureAdapter();
      // scale=2: high-res source so HiDPI stays crisp. The widget pins display
      // width to half this (logical size); raw-PNG hosts show it column-width.
      return adapter.renderBlocksImage(code, 2);
    }),
};
