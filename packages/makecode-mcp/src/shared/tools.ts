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

const SESSION_ID_PROP = {
  session_id: {
    type: "string",
    description:
      "Opaque session identifier returned by start_session. Required on every stateful call.",
  },
};

const CODE_PROP = {
  code: {
    type: "string",
    description: "MakeCode TypeScript source.",
  },
};

const noSessionHint =
  "If the session_id is missing, unknown, or expired, the tool returns an error — call start_session first to get a new one.";

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
  {
    type: "function",
    function: {
      name: "get_hex_file_from_code",
      description:
        "Compile the given TypeScript and return the micro:bit .hex as a base64 string. Not supported on the browser target — use set_code + get_hex_file instead.",
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
// first-class. Each session_id maps to an isolated puppeteer tab.

export const serverTools: ToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "start_session",
      description:
        "Allocate a new MakeCode editor session and return its session_id. Every stateful tool (set_code, get_current_code, get_blocks_image, get_hex_file, end_session) requires this id. IMPORTANT: this call is only the setup — after it returns, you MUST continue in the same response with the stateful tool(s) needed to fulfil the user's request (typically set_code). Do not stop after start_session alone; do not answer with plain text yet. Call end_session once the task is complete.",
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
      name: "end_session",
      description:
        "Close the MakeCode session identified by session_id and release its resources.",
      parameters: {
        type: "object",
        properties: { ...SESSION_ID_PROP },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_code",
      description: `Return the TypeScript source currently loaded in the editor for this session. ${noSessionHint}`,
      parameters: {
        type: "object",
        properties: { ...SESSION_ID_PROP },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_code",
      description: `Replace the TypeScript source in the editor for this session with the given code. Typical follow-ups in the same response: get_blocks_image to show the user their program as blocks, or get_hex_file to produce a downloadable firmware image. ${noSessionHint}`,
      parameters: {
        type: "object",
        properties: {
          ...SESSION_ID_PROP,
          ...CODE_PROP,
        },
        required: ["session_id", "code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocks_image",
      description: `Render the currently-loaded code as a PNG image of the equivalent MakeCode blocks. Call this after producing or modifying a program so the user sees the block view inline. ${loadedServerHint} ${noSessionHint}`,
      parameters: {
        type: "object",
        properties: { ...SESSION_ID_PROP },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_hex_file",
      description: `Compile the currently-loaded code and return the micro:bit .hex as a base64 string. ${loadedServerHint} ${noSessionHint}`,
      parameters: {
        type: "object",
        properties: { ...SESSION_ID_PROP },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocks_image_from_code",
      description:
        "Render the given TypeScript as a PNG image of the equivalent MakeCode blocks. Stateless — does not touch any session.",
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
      name: "get_hex_file_from_code",
      description:
        "Compile the given TypeScript and return the micro:bit .hex as a base64 string. Stateless — does not touch any session. Server target only; on the browser target use set_code + get_hex_file within a session.",
      parameters: {
        type: "object",
        properties: { ...CODE_PROP },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
];

export const serverToolNames = serverTools.map((t) => t.function.name);
