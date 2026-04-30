import { z } from "zod";

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
  additionalProperties?: false;
}

export interface ToolDescriptor {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

const CODE_PROP = {
  code: {
    type: "string",
    description: "MakeCode TypeScript source.",
  },
};

const noSessionHint =
  "If the session_id is missing or unknown, the tool returns an error — call start_session first to get a new one.";

const loadedBrowserHint =
  "The editor must already have code loaded (via set_code) before this call.";

const loadedServerHint =
  "The editor must already have code loaded (via set_code) in this session.";

// ─── Browser target ─────────────────────────────────────────────────────────
// One executor per iframe; the iframe *is* the session. No start/end lifecycle,
// no session_id on any tool. Stateful tools (set_code, get_current_code,
// get_blocks_image, get_hex_file) act on the iframe's current state directly.

export const browserTools: ToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "get_current_code",
      description:
        "Return the TypeScript source currently loaded in the MakeCode editor.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_code",
      description:
        "Replace the TypeScript source in the MakeCode editor with the given code. Typical follow-up: get_blocks_image to show the user their program as blocks, or get_hex_file to produce a downloadable firmware image.",
      parameters: {
        type: "object",
        properties: { ...CODE_PROP },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocks_image",
      description: `Render the code currently loaded in the editor as a PNG image of the equivalent MakeCode blocks. Call this after producing or modifying a program so the user sees the block view inline. ${loadedBrowserHint}`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_hex_file",
      description: `Compile the code currently loaded in the editor and return the micro:bit .hex as a base64 string. ${loadedBrowserHint}`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocks_image_from_code",
      description:
        "Render the given TypeScript as a PNG image of the equivalent MakeCode blocks without loading it into the editor. Useful for previewing code snippets while the user is still discussing changes.",
      parameters: {
        type: "object",
        properties: { ...CODE_PROP },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
];

export const browserToolNames = browserTools.map((t) => t.function.name);

// ─── Server target ──────────────────────────────────────────────────────────
// A single MCP server can multiplex many LLM clients, so sessions are
// first-class. We define each tool as a Zod input shape + description, then
// derive the JSON Schema descriptors from the same shapes (single source of
// truth) and feed the raw shapes straight into McpServer.registerTool.

const sessionIdField = z
  .string()
  .describe(
    "Opaque session identifier returned by start_session. Required on every stateful call.",
  );

const codeField = z.string().describe("MakeCode TypeScript source.");

export interface ServerToolMeta<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  inputShape: Shape;
}

export const serverToolMeta = {
  start_session: {
    description:
      "Allocate a new MakeCode editor session and return its session_id. Every stateful tool (set_code, get_current_code, get_blocks_image, get_hex_file, end_session) requires this id. IMPORTANT: this call is only the setup — after it returns, you MUST continue in the same response with the stateful tool(s) needed to fulfil the user's request (typically set_code). Do not stop after start_session alone; do not answer with plain text yet. Call end_session once the task is complete.",
    inputShape: {},
  },
  end_session: {
    description:
      "Close the MakeCode session identified by session_id and release its resources.",
    inputShape: { session_id: sessionIdField },
  },
  get_current_code: {
    description: `Return the TypeScript source currently loaded in the editor for this session. ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  set_code: {
    description: `Replace the TypeScript source in the editor for this session with the given code. Typical follow-ups in the same response: get_blocks_image to show the user their program as blocks, or get_hex_file to produce a downloadable firmware image. ${noSessionHint}`,
    inputShape: { session_id: sessionIdField, code: codeField },
  },
  get_blocks_image: {
    description: `Render the currently-loaded code as a PNG image of the equivalent MakeCode blocks. Call this after producing or modifying a program so the user sees the block view inline. ${loadedServerHint} ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  get_hex_file: {
    description: `Compile the currently-loaded code and return the micro:bit .hex as a base64 string. ${loadedServerHint} ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  get_blocks_image_from_code: {
    description:
      "Render the given TypeScript as a PNG image of the equivalent MakeCode blocks. Stateless — does not touch any session.",
    inputShape: { code: codeField },
  },
  get_hex_file_from_code: {
    description:
      "Compile the given TypeScript and return the micro:bit .hex as a base64 string. Stateless — does not touch any session. Server target only; on the browser target use set_code + get_hex_file within a session.",
    inputShape: { code: codeField },
  },
} as const satisfies Record<string, ServerToolMeta>;

export type ServerToolName = keyof typeof serverToolMeta;

function shapeToParameters(shape: z.ZodRawShape): ToolParameterSchema {
  const json = z.toJSONSchema(z.strictObject(shape)) as {
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  return {
    type: "object",
    properties: json.properties ?? {},
    required: json.required ?? [],
    additionalProperties: false,
  };
}

export const serverTools: ToolDescriptor[] = (
  Object.keys(serverToolMeta) as ServerToolName[]
).map((name) => ({
  type: "function",
  function: {
    name,
    description: serverToolMeta[name].description,
    parameters: shapeToParameters(serverToolMeta[name].inputShape),
  },
}));

export const serverToolNames = serverTools.map((t) => t.function.name);
