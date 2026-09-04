import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerExecutor } from "../shared/types.js";
import { isSessionError } from "../shared/types.js";
import { serverToolMeta, TOOL } from "../shared/tools.js";
import { blocksImageMcpContent, hexFileMcpPayload } from "../shared/tool-results.js";
import { CDN_ORIGIN, MAKECODE_ORIGIN, SIM_ORIGIN } from "./makecode-mirror.js";
import { createLogger, preview } from "../shared/logger.js";

const log = createLogger("mcp");

// MCP Apps inline-rendering widget. Both image-returning tools point hosts at
// this resource via `_meta.ui.resourceUri`. The mimeType must be exactly
// `text/html;profile=mcp-app` — `@mcp-ui/client` strict-equality-checks it;
// plain `text/html` and OpenAI's `text/html+skybridge` are both rejected with
// "Unsupported UI resource content format". The HTML is read once at module
// init (fail-fast like shell-server.ts: missing prebuilt → re-run `npm run
// build`).
const BLOCKS_VIEWER_URI = "ui://makecode-mcp/blocks-viewer.html";
const BLOCKS_VIEWER_MIME = "text/html;profile=mcp-app";
const BLOCKS_VIEWER_META = { ui: { resourceUri: BLOCKS_VIEWER_URI } };
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIST = resolve(HERE, "..", "shell");
const BLOCKS_VIEWER_HTML = readFileSync(resolve(SHELL_DIST, "blocks-viewer.html"), "utf8");
log.info("blocks-viewer widget loaded", { bytes: BLOCKS_VIEWER_HTML.length });

// The live-session widget. Unlike blocks-viewer it can't be self-contained:
// the host's sandbox won't frame makecode.microbit.org, so the page embeds a
// bridge served from this server's own origin, which does. The placeholder is
// filled in per read because the port is only known once the shell server is
// listening.
const EDITOR_URI = "ui://makecode-mcp/editor.html";
const APP_JS_PLACEHOLDER = "__MKCP_APP_JS__";
const CONFIG_PLACEHOLDER = "__MKCP_CONFIG__";
const EDITOR_META = { ui: { resourceUri: EDITOR_URI } };
const EDITOR_HTML = readFileSync(resolve(SHELL_DIST, "editor.html"), "utf8");
// The HTML pages sit beside this module in both src and dist, but the widget
// bundle is a build artifact, so a source-run test has to reach into dist.
const readShellAsset = (name: string): string => {
  try {
    return readFileSync(resolve(SHELL_DIST, name), "utf8");
  } catch {
    return readFileSync(resolve(HERE, "..", "..", "dist", "shell", name), "utf8");
  }
};
const EDITOR_APP_JS = readShellAsset("widget-app.js");
log.info("session-editor widget loaded", { bytes: EDITOR_HTML.length });

export interface McpServerOptions {
  executor: ServerExecutor;
  /**
   * Localhost bridge page the live-editor widget embeds. Omit and the widget
   * is left unregistered: every tool still works, hosts just get no editor.
   */
  editorBridge?: { origin: string; token: string };
  name?: string;
  version?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean };

const textResult = (payload: unknown, isError = false): ToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

const imageResult = (pngBase64: string): ToolResult => ({
  content: [blocksImageMcpContent(pngBase64)],
});

// Wraps a tool handler so SessionError surfaces as {isError, code} and other
// throws as {isError, error}. Without this McpServer turns throws into
// transport-level errors and we lose the session taxonomy.
function safe(name: string, fn: () => Promise<ToolResult>) {
  return async (): Promise<ToolResult> => {
    log.info(`CallTool → ${name}`);
    const end = log.time(`CallTool ${name}`);
    try {
      const result = await fn();
      end();
      log.info(`CallTool ← ${name} ok`);
      return result;
    } catch (err) {
      end();
      const error = err instanceof Error ? err.message : String(err);
      if (isSessionError(err)) {
        log.warn(`CallTool ← ${name} session error`, { code: err.code, error });
        return textResult({ error, code: err.code }, true);
      }
      log.error(`CallTool ← ${name} error`, error);
      return textResult({ error }, true);
    }
  };
}

export function buildMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: options.name ?? "makecode-mcp", version: options.version ?? "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  const exec = options.executor;
  const m = serverToolMeta;

  const reg = <Args>(
    name: keyof typeof serverToolMeta,
    handler: (args: Args) => Promise<ToolResult>,
    meta?: Record<string, unknown>,
  ) =>
    server.registerTool(
      name,
      {
        description: m[name].description,
        inputSchema: m[name].inputShape,
        ...(meta ? { _meta: meta } : {}),
      },
      ((args: Args) => {
        log.debug(`args ${name}`, { args: preview(args) });
        return safe(name, () => handler(args))();
      }) as never,
    );

  server.registerResource(
    "blocks-viewer",
    BLOCKS_VIEWER_URI,
    {
      mimeType: BLOCKS_VIEWER_MIME,
      description:
        "MCP Apps widget that renders the blocks-image tool result inline in the chat.",
    },
    async () => {
      log.info(`ReadResource → ${BLOCKS_VIEWER_URI}`);
      return {
        contents: [
          { uri: BLOCKS_VIEWER_URI, mimeType: BLOCKS_VIEWER_MIME, text: BLOCKS_VIEWER_HTML },
        ],
      };
    },
  );

  const bridge = options.editorBridge;
  if (bridge) {
    // The only host-side permission this design depends on: the widget must be
    // allowed to frame (and reach) our localhost origin.
    // `domain` asks for a dedicated sandbox origin. Hosts strip
    // `allow-same-origin` from the default widget sandbox, and nested frames
    // inherit those flags, so without it MakeCode loads with no IndexedDB,
    // cookies or service worker and never finishes booting. The value's format
    // is host-defined; hosts that don't recognise it fall back to their default
    // origin.
    // The widget hosts MakeCode in a blob iframe (hosts allow blob: but not
    // third-party frames), loading its scripts and data straight from MakeCode.
    const editorOrigins = [bridge.origin, MAKECODE_ORIGIN, CDN_ORIGIN, SIM_ORIGIN];
    // MakeCode inlines fonts and images as data: URIs, and hosts build img-src
    // and font-src from resourceDomains alone, so the schemes must be declared.
    const editorResources = [...editorOrigins, "data:", "blob:"];
    const cspMeta = {
      ui: {
        csp: {
          frameDomains: ["blob:", bridge.origin],
          connectDomains: editorOrigins,
          resourceDomains: editorResources,
        },
      },
      // ChatGPT reads this legacy snake_case key rather than ui.csp. Harmless
      // to hosts that don't, which ignore unknown _meta entries.
      "openai/widgetCSP": {
        connect_domains: editorOrigins,
        resource_domains: editorResources,
        frame_domains: ["blob:", bridge.origin],
      },
    };
    server.registerResource(
      "session-editor",
      EDITOR_URI,
      {
        mimeType: BLOCKS_VIEWER_MIME,
        description:
          "MCP Apps widget showing the live MakeCode editor for a session, editable in place.",
        _meta: cspMeta,
      },
      async () => {
        log.info(`ReadResource → ${EDITOR_URI}`);
        // Repeated on the read result (and on the content) because that is the
        // call a host makes at render time; omitted there it applies its
        // default of frame-src 'none' and the bridge iframe silently blanks.
        return {
          _meta: cspMeta,
          contents: [
            {
              uri: EDITOR_URI,
              mimeType: BLOCKS_VIEWER_MIME,
              // Function replacers: a `$&` in a token or origin would
              // otherwise be interpreted as a capture reference.
              text: EDITOR_HTML.replace(CONFIG_PLACEHOLDER, () =>
                JSON.stringify({ origin: bridge.origin, token: bridge.token }),
              )
                // Inlined, not linked: 'unsafe-inline' is always allowed while
                // our origin may be missing from the host's script-src.
                .replace(APP_JS_PLACEHOLDER, () => EDITOR_APP_JS),
              _meta: cspMeta,
            },
          ],
        };
      },
    );
  }
  const editorMeta = bridge ? EDITOR_META : undefined;

  reg<{ label?: string }>(
    TOOL.SESSION_START,
    async ({ label }) =>
      textResult(await exec.startSession(label !== undefined ? { label } : undefined)),
    editorMeta,
  );
  reg<{ session_id: string }>(TOOL.SESSION_END, async ({ session_id }) => {
    await exec.endSession(session_id);
    return textResult({ ok: true });
  });
  reg<{ session_id: string }>(TOOL.SESSION_GET_CODE, async ({ session_id }) =>
    textResult({ code: await exec.getCurrentCode(session_id) }),
  );
  reg<{ session_id: string; code: string }>(
    TOOL.SESSION_SET_CODE,
    async ({ session_id, code }) => {
      await exec.setCode(session_id, code);
      // The session id rides along so an already-attached widget (and any view
      // created later) knows which session this refers to.
      return textResult({ ok: true, session_id });
    },
  );
  reg<{ session_id: string }>(
    TOOL.SESSION_GET_BLOCKS_IMG,
    async ({ session_id }) => {
      const { pngBase64 } = await exec.getBlocksImage(session_id);
      return imageResult(pngBase64);
    },
    BLOCKS_VIEWER_META,
  );
  reg<{ session_id: string }>(TOOL.SESSION_GET_HEX_FILE, async ({ session_id }) =>
    textResult(hexFileMcpPayload(await exec.getHexFile(session_id))),
  );
  reg<{ code: string }>(
    TOOL.GET_BLOCKS_IMG_FROM_CODE,
    async ({ code }) => {
      const { pngBase64 } = await exec.getBlocksImageFromCode(code);
      return imageResult(pngBase64);
    },
    BLOCKS_VIEWER_META,
  );
  reg<{ code: string }>(TOOL.GET_HEX_FILE_FROM_CODE, async ({ code }) =>
    textResult(hexFileMcpPayload(await exec.getHexFileFromCode(code))),
  );

  log.info("MCP server built", { tools: Object.keys(m).length });
  return server;
}
