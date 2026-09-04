import {
  createMakeCodeURL,
  MakeCodeFrameDriver,
} from "@microbit/makecode-embed/vanilla";
import { MakeCodeFrameDriverAdapter } from "../browser/frame-driver-adapter.js";
import { createLogger } from "../shared/logger.js";
import { fillProjectDefaults } from "../shared/project-defaults.js";
import { ProjectSync, type ViewMessage } from "./widget-sync.js";

// Runs in the bridge iframe, which the MCP App widget embeds from this
// server's own origin. Same adapter as the Puppeteer shell and the React
// panel; the only difference is where the project comes from and goes to
// (this server's SessionStore, over SSE and fetch).

const log = createLogger("widget-shim");

const params = new URLSearchParams(location.search);
const sessionId = params.get("session") ?? "";
const token = params.get("token") ?? "";
// Identifies this view for the lifetime of the page, so the server can skip
// echoing our own edits back at us.
const viewId =
  globalThis.crypto?.randomUUID?.() ?? `view-${Math.random().toString(36).slice(2)}`;

const statusEl = document.getElementById("status") as HTMLDivElement;
let markEditorLoaded!: () => void;
const editorLoaded = new Promise<void>((r) => {
  markEditorLoaded = r;
});
function status(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = text ? (isError ? "on err" : "on") : "";
}

const widgetUrl = (path: string) =>
  `${location.origin}${path}?session=${encodeURIComponent(sessionId)}` +
  `&token=${encodeURIComponent(token)}&view=${encodeURIComponent(viewId)}`;

let adapter: MakeCodeFrameDriverAdapter | undefined;

const sync = new ProjectSync({
  apply: async (files) => {
    await editorLoaded;
    // setProject (not initialProjects) because it switches to blocks, so a
    // stored main.blocks that lags main.ts is re-decompiled instead of
    // overwriting the code. Failures propagate on purpose; see the same call
    // in widget-app.ts.
    await adapter!.setProject({ text: files });
    status("");
  },
  readEditor: async () => (await adapter!.getProject()).text,
  save: async (files, baseVersion) => {
    const res = await fetch(widgetUrl("/widget/save"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion, files }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const body = (await res.json()) as { version: number };
    log.info("sent user edit to the server", { version: body.version });
    return body.version;
  },
  onSessionGone: () => {
    events.close();
    status("This session has ended. The assistant can start a new one.", true);
  },
  onError: (err) => log.warn("sync error", { error: String(err) }),
});

// The editor is cross-origin, so the local compiler could not read its own
// errors here anyway; skip pre-validation (the server already ran it).
const noDiagnostics = async () => [];

const iframe = document.getElementById("mk") as HTMLIFrameElement;
iframe.src = createMakeCodeURL(
  "https://makecode.microbit.org",
  undefined,
  undefined,
  2,
  undefined,
);
const driver = new MakeCodeFrameDriver(
  {
    controllerId: "mkcp-widget",
    // Boot empty and let the session's project arrive through `apply`; see
    // there for why the editor must not be handed stored files directly.
    initialProjects: async () => [{ text: fillProjectDefaults({}, "") }],
    onWorkspaceSave: (e) => {
      adapter?.handleWorkspaceSave(e);
      const text = e.project.text;
      if (text) sync.workspaceSaved(text);
    },
    onEditorContentLoaded: () => markEditorLoaded(),
    onDownload: (d) => adapter?.handleDownload(d),
  },
  () => iframe,
);
adapter = new MakeCodeFrameDriverAdapter(driver, noDiagnostics);
driver.initialize();

// EventSource retries on its own; give up only once it is clear the server
// isn't there, so a restarting server still recovers silently.
let consecutiveErrors = 0;
const events = new EventSource(widgetUrl("/widget/events"));
events.onopen = () => {
  consecutiveErrors = 0;
};
events.onmessage = (event) => {
  consecutiveErrors = 0;
  try {
    sync.receive(JSON.parse(event.data) as ViewMessage);
  } catch (err) {
    log.warn("bad message from server", { error: String(err) });
  }
};
events.onerror = () => {
  if (++consecutiveErrors < 4) {
    status("Reconnecting to the MakeCode session…");
    return;
  }
  events.close();
  status("Lost the connection to the MakeCode MCP server.", true);
};

status("Opening the MakeCode session…");
log.info("widget bridge starting", { session_id: sessionId, view: viewId });

// Inspection surface, mirroring window.__mkcp in the Puppeteer shell. The
// editor is cross-origin, so this is the only way to see what it actually
// holds — from a test, or from a console when debugging inside a host.
declare global {
  interface Window {
    __mkcpBridge: {
      ready(): Promise<void>;
      project(): Promise<Record<string, string>>;
      status(): string;
      version(): number;
    };
  }
}
window.__mkcpBridge = {
  ready: () => editorLoaded,
  project: async () => (await adapter!.getProject()).text,
  status: () => statusEl.textContent ?? "",
  version: () => sync.version,
};
