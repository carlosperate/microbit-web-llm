import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerExecutor } from "../shared/types.js";
import { isSessionError } from "../shared/types.js";
import { serverTools as TOOL_DESCRIPTORS } from "../shared/tools.js";
import { createLogger, preview } from "../shared/logger.js";

const log = createLogger("mcp");

export interface McpServerOptions {
  executor: ServerExecutor;
  name?: string;
  version?: string;
}

type ToolArgs = Record<string, unknown>;
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean };
type Dispatch = (exec: ServerExecutor, a: ToolArgs) => Promise<ToolResult>;

const sid = (a: ToolArgs) => String(a.session_id ?? "");
const code = (a: ToolArgs) => String(a.code ?? "");

function textResult(payload: unknown, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function imageResult(pngBase64: string): ToolResult {
  return {
    content: [{ type: "image" as const, data: pngBase64, mimeType: "image/png" }],
  };
}

const dispatch: Record<string, Dispatch> = {
  start_session: async (e) => textResult(await e.startSession()),
  end_session: async (e, a) => {
    await e.endSession(sid(a));
    return textResult({ ok: true });
  },
  get_current_code: async (e, a) =>
    textResult({ code: await e.getCurrentCode(sid(a)) }),
  set_code: async (e, a) => {
    await e.setCode(sid(a), code(a));
    return textResult({ ok: true });
  },
  get_blocks_image: async (e, a) => {
    const { pngBase64 } = await e.getBlocksImage(sid(a));
    return imageResult(pngBase64);
  },
  get_hex_file: async (e, a) =>
    textResult({ hex_base64: await e.getHexFile(sid(a)) }),
  get_blocks_image_from_code: async (e, a) => {
    const { pngBase64 } = await e.getBlocksImageFromCode(code(a));
    return imageResult(pngBase64);
  },
  get_hex_file_from_code: async (e, a) =>
    textResult({ hex_base64: await e.getHexFileFromCode(code(a)) }),
};

export function buildMcpServer(options: McpServerOptions): Server {
  const server = new Server(
    {
      name: options.name ?? "makecode-mcp",
      version: options.version ?? "0.0.0",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info("ListTools");
    return {
      tools: TOOL_DESCRIPTORS.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        inputSchema: t.function.parameters,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as ToolArgs;
    log.info(`CallTool → ${name}`, { args: preview(args) });
    const end = log.time(`CallTool ${name}`);
    const handler = dispatch[name];
    if (!handler) {
      end();
      log.warn(`unknown tool: ${name}`);
      return textResult({ error: `Unknown tool: ${name}` }, true);
    }
    try {
      const result = await handler(options.executor, args);
      end();
      log.info(`CallTool ← ${name} ok`);
      return result;
    } catch (err) {
      end();
      const error = err instanceof Error ? err.message : String(err);
      if (isSessionError(err)) {
        log.warn(`CallTool ← ${name} session error`, { code: err.code, error });
      } else {
        log.error(`CallTool ← ${name} error`, error);
      }
      return textResult(
        isSessionError(err) ? { error, code: err.code } : { error },
        true,
      );
    }
  });

  log.info("MCP server built", { tools: TOOL_DESCRIPTORS.length });
  return server;
}
