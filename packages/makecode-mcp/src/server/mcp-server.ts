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
type Dispatch = (exec: ServerExecutor, a: ToolArgs) => Promise<unknown>;

const sid = (a: ToolArgs) => String(a.session_id ?? "");
const code = (a: ToolArgs) => String(a.code ?? "");

const dispatch: Record<string, Dispatch> = {
  start_session: (e) => e.startSession(),
  end_session: async (e, a) => {
    await e.endSession(sid(a));
    return { ok: true };
  },
  get_current_code: async (e, a) => ({ code: await e.getCurrentCode(sid(a)) }),
  set_code: async (e, a) => {
    await e.setCode(sid(a), code(a));
    return { ok: true };
  },
  get_blocks_svg: async (e, a) => ({ svg: await e.getBlocksSvg(sid(a)) }),
  get_hex_file: async (e, a) => ({ hex_base64: await e.getHexFile(sid(a)) }),
  get_blocks_svg_from_code: async (e, a) => ({
    svg: await e.getBlocksSvgFromCode(code(a)),
  }),
  get_hex_file_from_code: async (e, a) => ({
    hex_base64: await e.getHexFileFromCode(code(a)),
  }),
};

function textResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

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
      const result = textResult(await handler(options.executor, args));
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
