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

const noSessionHint =
  "If the session_id is missing, unknown, or expired, the tool returns an error — call start_session first to get a new one.";

const loadedCodeHint =
  "The editor must already have code loaded (via set_code) in this session.";

export const tools: ToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "start_session",
      description:
        "Allocate a new MakeCode editor session and return its session_id. Every stateful tool requires this id. Call end_session when finished.",
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
      description: `Replace the TypeScript source in the editor for this session with the given code. ${noSessionHint}`,
      parameters: {
        type: "object",
        properties: {
          ...SESSION_ID_PROP,
          code: {
            type: "string",
            description: "MakeCode TypeScript source to load into the editor.",
          },
        },
        required: ["session_id", "code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocks_svg",
      description: `Render the currently-loaded code as a blocks SVG. ${loadedCodeHint} ${noSessionHint}`,
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
      description: `Compile the currently-loaded code and return the micro:bit .hex as a base64 string. ${loadedCodeHint} ${noSessionHint}`,
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
      name: "get_blocks_svg_from_code",
      description:
        "Render the given TypeScript as a blocks SVG. Stateless — does not touch any session.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "MakeCode TypeScript source to render.",
          },
        },
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
        properties: {
          code: {
            type: "string",
            description: "MakeCode TypeScript source to compile.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
];

export const toolNames = tools.map((t) => t.function.name);
