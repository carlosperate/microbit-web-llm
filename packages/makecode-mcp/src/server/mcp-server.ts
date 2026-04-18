import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MakeCodeExecutor } from "../shared/types.js";
import { isSessionError } from "../shared/types.js";
import { tools as TOOL_DESCRIPTORS } from "../shared/tools.js";

export interface McpServerOptions {
  executor: MakeCodeExecutor;
  name?: string;
  version?: string;
}

type ToolArgs = Record<string, unknown>;
type Dispatch = (exec: MakeCodeExecutor, a: ToolArgs) => Promise<unknown>;

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = dispatch[req.params.name];
    if (!handler) return textResult({ error: `Unknown tool: ${req.params.name}` }, true);
    try {
      return textResult(
        await handler(options.executor, (req.params.arguments ?? {}) as ToolArgs),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return textResult(
        isSessionError(err) ? { error, code: err.code } : { error },
        true,
      );
    }
  });

  return server;
}
