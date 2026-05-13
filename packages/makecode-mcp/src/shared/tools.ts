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

// ─── Tool-name constants ────────────────────────────────────────────────────
// Single source of truth for every tool identifier. Every consumer (this file
// included) references these constants instead of repeating the literal —
// renaming a tool is a one-line change here, and TypeScript narrowing on the
// `*ToolName` unions catches typos at build time.

export const TOOL = {
  SESSION_START: "session_start",
  SESSION_END: "session_end",
  SESSION_GET_CODE: "session_get_code",
  SESSION_SET_CODE: "session_set_code",
  SESSION_GET_BLOCKS_IMG: "session_get_blocks_img",
  SESSION_GET_HEX_FILE: "session_get_hex_file",
  GET_BLOCKS_IMG_FROM_CODE: "get_blocks_img_from_code",
  GET_HEX_FILE_FROM_CODE: "get_hex_file_from_code",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

// Image-producing tools (PNG base64 result). Consumers that need to render
// the result inline or stub it in flattened history use this set.
export const IMAGE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  TOOL.SESSION_GET_BLOCKS_IMG,
  TOOL.GET_BLOCKS_IMG_FROM_CODE,
]);

// Hex-producing tools (binary opaque result). Same role as IMAGE_TOOL_NAMES.
export const HEX_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  TOOL.SESSION_GET_HEX_FILE,
  TOOL.GET_HEX_FILE_FROM_CODE,
]);

const CODE_PROP = {
  code: {
    type: "string",
    description: "MakeCode TypeScript source.",
  },
};

const noSessionHint = `If the session_id is missing or unknown, the tool returns an error — call ${TOOL.SESSION_START} first to get a new one.`;

const loadedBrowserHint = `The editor must already have code loaded (via ${TOOL.SESSION_SET_CODE}) before this call.`;

const loadedServerHint = `The editor must already have code loaded (via ${TOOL.SESSION_SET_CODE}) in this session.`;

// ─── Browser target ─────────────────────────────────────────────────────────
// One executor per iframe; the iframe *is* the session. No start/end lifecycle,
// no session_id on any tool. Stateful tools (SESSION_SET_CODE, SESSION_GET_CODE,
// SESSION_GET_BLOCKS_IMG, SESSION_GET_HEX_FILE) act on the iframe's current
// state directly.

export const BROWSER_TOOL_NAMES = [
  TOOL.SESSION_GET_CODE,
  TOOL.SESSION_SET_CODE,
  TOOL.SESSION_GET_BLOCKS_IMG,
  TOOL.SESSION_GET_HEX_FILE,
  TOOL.GET_BLOCKS_IMG_FROM_CODE,
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export const browserTools: ToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: TOOL.SESSION_GET_CODE,
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
      name: TOOL.SESSION_SET_CODE,
      description: `Replace the TypeScript source in the MakeCode editor with the given code. Typical follow-up: ${TOOL.SESSION_GET_BLOCKS_IMG} to show the user their program as blocks, or ${TOOL.SESSION_GET_HEX_FILE} to produce a downloadable firmware image.`,
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
      name: TOOL.SESSION_GET_BLOCKS_IMG,
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
      name: TOOL.SESSION_GET_HEX_FILE,
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
      name: TOOL.GET_BLOCKS_IMG_FROM_CODE,
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
    `Opaque session identifier returned by ${TOOL.SESSION_START}. Required on every stateful call.`,
  );

const codeField = z.string().describe("MakeCode TypeScript source.");

export interface ServerToolMeta<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  inputShape: Shape;
}

export const serverToolMeta = {
  [TOOL.SESSION_START]: {
    description: `Allocate a new MakeCode editor session and return its session_id. Every stateful tool (${TOOL.SESSION_SET_CODE}, ${TOOL.SESSION_GET_CODE}, ${TOOL.SESSION_GET_BLOCKS_IMG}, ${TOOL.SESSION_GET_HEX_FILE}, ${TOOL.SESSION_END}) requires this id. IMPORTANT: this call is only the setup — after it returns, you MUST continue in the same response with the stateful tool(s) needed to fulfil the user's request (typically ${TOOL.SESSION_SET_CODE}). Do not stop after ${TOOL.SESSION_START} alone; do not answer with plain text yet. Call ${TOOL.SESSION_END} once the task is complete.`,
    inputShape: {
      label: z
        .string()
        .optional()
        .describe(
          "Optional human label shown in the OS window title when the server runs in headed mode; ignored otherwise.",
        ),
    },
  },
  [TOOL.SESSION_END]: {
    description:
      "Close the MakeCode session identified by session_id and release its resources.",
    inputShape: { session_id: sessionIdField },
  },
  [TOOL.SESSION_GET_CODE]: {
    description: `Return the TypeScript source currently loaded in the editor for this session. ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  [TOOL.SESSION_SET_CODE]: {
    description: `Replace the TypeScript source in the editor for this session with the given code. Typical follow-ups in the same response: ${TOOL.SESSION_GET_BLOCKS_IMG} to show the user their program as blocks, or ${TOOL.SESSION_GET_HEX_FILE} to produce a downloadable firmware image. ${noSessionHint}`,
    inputShape: { session_id: sessionIdField, code: codeField },
  },
  [TOOL.SESSION_GET_BLOCKS_IMG]: {
    description: `Render the currently-loaded code as a PNG image of the equivalent MakeCode blocks. Call this after producing or modifying a program so the user sees the block view inline. ${loadedServerHint} ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  [TOOL.SESSION_GET_HEX_FILE]: {
    description: `Compile the currently-loaded code and return the micro:bit .hex as a base64 string. ${loadedServerHint} ${noSessionHint}`,
    inputShape: { session_id: sessionIdField },
  },
  [TOOL.GET_BLOCKS_IMG_FROM_CODE]: {
    description:
      "Render the given TypeScript as a PNG image of the equivalent MakeCode blocks. Stateless — does not touch any session.",
    inputShape: { code: codeField },
  },
  [TOOL.GET_HEX_FILE_FROM_CODE]: {
    description: `Compile the given TypeScript and return the micro:bit .hex as a base64 string. Stateless — does not touch any session. Server target only; on the browser target use ${TOOL.SESSION_SET_CODE} + ${TOOL.SESSION_GET_HEX_FILE} within a session.`,
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
