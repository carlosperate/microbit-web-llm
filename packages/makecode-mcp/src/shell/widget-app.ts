import { MakeCodeFrameDriver } from "@microbit/makecode-embed/vanilla";
import { MakeCodeFrameDriverAdapter } from "../browser/frame-driver-adapter.js";
import { createLogger } from "../shared/logger.js";
import { fillProjectDefaults } from "../shared/project-defaults.js";
import { browserBlobBoot, buildMakeCodeBlobUrl } from "./makecode-blob.js";
import { ProjectSync, type ViewMessage } from "./widget-sync.js";
import { connectHost, findSessionId, requestHeight } from "./widget-host.js";

// The MCP App itself. Unlike the bridge page, this document *is* the widget the
// host renders, so it hosts MakeCode in a blob iframe rather than framing our
// server (which hosts such as Claude refuse). Everything it needs is inlined at
// resources/read time; only data crosses to our server, over SSE and fetch.
const log = createLogger("widget-app");

// Substituted into the page at resources/read time: the widget is served by
// the host, so it can't read them from its own URL.
const config = window.__mkcpConfig;
const SERVER_ORIGIN = config.origin;
const TOKEN = config.token;
// MakeCode runs in a blob frame that is same-origin with this document, so
// anything left on `window` is readable by it. Closures are not.
delete (window as { __mkcpConfig?: unknown }).__mkcpConfig;

// Tall enough for MakeCode's toolbox, canvas and simulator side by side.
const EDITOR_HEIGHT = 720;

const viewId =
  globalThis.crypto?.randomUUID?.() ?? `view-${Math.random().toString(36).slice(2)}`;

const statusEl = document.getElementById("status") as HTMLDivElement;
const frameHolder = document.getElementById("editor") as HTMLDivElement;
function status(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = text ? (isError ? "status err" : "status") : "status hidden";
}

let adapter: MakeCodeFrameDriverAdapter | undefined;
let events: EventSource | undefined;
let started = "";

let markEditorLoaded!: () => void;
const editorLoaded = new Promise<void>((r) => {
  markEditorLoaded = r;
});

// Every failure so far has been a host CSP directive we could not see from
// here, so record violations and report them rather than hanging on a spinner.
const violations: string[] = [];
let enforcedPolicy = "";
document.addEventListener("securitypolicyviolation", (e) => {
  const line = `${e.violatedDirective} blocked ${String(e.blockedURI).slice(0, 60)}`;
  if (!violations.includes(line)) violations.push(line);
  enforcedPolicy = e.originalPolicy;
});

function reportStuck(): void {
  const blocking = violations.filter((v) => !/usabilla|visualstudio|analytics/i.test(v));
  status(
    "The MakeCode editor did not finish loading. " +
      (blocking.length
        ? `Blocked by this host: ${blocking.slice(0, 4).join(" · ")}. `
        : "No CSP violation was reported. ") +
      (enforcedPolicy ? `Enforced policy: ${enforcedPolicy.slice(0, 900)}` : ""),
    true,
  );
}

const widgetUrl = (path: string, sessionId: string) =>
  `${SERVER_ORIGIN}${path}?session=${encodeURIComponent(sessionId)}` +
  `&token=${encodeURIComponent(TOKEN)}&view=${encodeURIComponent(viewId)}`;

async function start(sessionId: string): Promise<void> {
  // The host re-sends the tool result on every render; reloading would throw
  // away whatever the user has dragged since.
  if (started === sessionId) return;
  if (started) {
    // Only session_start advertises this widget, so one widget means one
    // session. Honouring a second id would stack editors, leave the old stream
    // open and reuse an already-resolved editorLoaded.
    log.warn("ignoring a second session in this widget", { showing: started, offered: sessionId });
    return;
  }
  started = sessionId;
  status("Loading the MakeCode editor…");
  requestHeight(EDITOR_HEIGHT);

  const sync = new ProjectSync({
    apply: async (files) => {
      await editorLoaded;
      // Must propagate: a swallowed failure looks like a successful import, and
      // ProjectSync would then reconcile the *previous* project back up to the
      // server, undoing the write the model just made.
      await adapter!.setProject({ text: files });
      status("");
    },
    readEditor: async () => (await adapter!.getProject()).text,
    save: async (files, baseVersion) => {
      const res = await fetch(widgetUrl("/widget/save", sessionId), {
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
      events?.close();
      status("This session has ended. The assistant can start a new one.", true);
    },
    onError: (err) => {
      log.warn("sync error", { error: String(err) });
      // Only while something is still on screen: once the editor is up it stays
      // usable, and replacing it with a banner over a working editor is worse.
      if (statusEl.textContent) status("Could not show the latest code in the editor.", true);
    },
  });

  const iframe = document.createElement("iframe");
  iframe.id = "mk";
  iframe.setAttribute("allow", "usb; serial; autoplay; microphone");
  iframe.src = await buildMakeCodeBlobUrl(browserBlobBoot(SERVER_ORIGIN));
  frameHolder.appendChild(iframe);

  const driver = new MakeCodeFrameDriver(
    {
      controllerId: "mkcp-widget",
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
  // The server validated anything it stored, and the editor is same-origin
  // here but still not ours to compile against; skip pre-validation.
  adapter = new MakeCodeFrameDriverAdapter(driver, async () => []);
  driver.initialize();

  const stuck = setTimeout(reportStuck, 45_000);
  void editorLoaded.then(() => {
    clearTimeout(stuck);
    requestHeight(EDITOR_HEIGHT);
  });

  let consecutiveErrors = 0;
  events = new EventSource(widgetUrl("/widget/events", sessionId));
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
    if (++consecutiveErrors < 4) return;
    events?.close();
    status("Lost the connection to the MakeCode MCP server.", true);
  };

  log.info("widget app starting", { session_id: sessionId, view: viewId });
  window.__mkcpWidget = {
    ready: () => editorLoaded,
    project: async () => (await adapter!.getProject()).text,
    status: () => statusEl.textContent ?? "",
    version: () => sync.version,
  };
}

declare global {
  interface Window {
    __mkcpConfig: { origin: string; token: string };
    __mkcpWidget: {
      ready(): Promise<void>;
      project(): Promise<Record<string, string>>;
      status(): string;
      version(): number;
    };
  }
}

connectHost({
  onToolResult: (params) => {
    const sessionId = findSessionId(params);
    if (sessionId) {
      void start(sessionId).catch((err: unknown) => {
        // Mirror fetches and blob creation can fail; without this the widget
        // sits on "Loading…" for ever and a later result is ignored because
        // `started` is already set.
        started = "";
        log.error("could not start the editor", { error: String(err) });
        status(`Could not load the MakeCode editor: ${String(err)}`, true);
      });
    } else if (!started) status("No MakeCode session in this tool result.", true);
  },
  onError: (message) => status(message, true),
});
status("Connecting to the host…");
