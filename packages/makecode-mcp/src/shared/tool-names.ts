// Split out of tools.ts so browser bundles can name a tool without pulling in
// the Zod schemas — the widget is inlined into an MCP resource, where every
// kilobyte is fetched by the host on each render.
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
