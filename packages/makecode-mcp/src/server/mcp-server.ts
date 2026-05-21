import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerExecutor } from "../shared/types.js";
import { isSessionError } from "../shared/types.js";
import { serverToolMeta, TOOL } from "../shared/tools.js";
import { blocksImageMcpContent, hexFileMcpPayload } from "../shared/tool-results.js";
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
const BLOCKS_VIEWER_HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "shell", "blocks-viewer.html"),
  "utf8",
);
log.info("blocks-viewer widget loaded", { bytes: BLOCKS_VIEWER_HTML.length });

export interface McpServerOptions {
  executor: ServerExecutor;
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

  reg<{ label?: string }>(TOOL.SESSION_START, async ({ label }) =>
    textResult(await exec.startSession(label !== undefined ? { label } : undefined)),
  );
  reg<{ session_id: string }>(TOOL.SESSION_END, async ({ session_id }) => {
    await exec.endSession(session_id);
    return textResult({ ok: true });
  });
  reg<{ session_id: string }>(TOOL.SESSION_GET_CODE, async ({ session_id }) =>
    textResult({ code: await exec.getCurrentCode(session_id) }),
  );
  reg<{ session_id: string; code: string }>(TOOL.SESSION_SET_CODE, async ({ session_id, code }) => {
    await exec.setCode(session_id, code);
    return textResult({ ok: true });
  });
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
