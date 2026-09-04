import { TOOL } from "./tool-names.js";

export const EMPTY_EDITOR_ERROR = `No code loaded in the editor. Call ${TOOL.SESSION_SET_CODE} first to load code before requesting ${TOOL.SESSION_GET_BLOCKS_IMG}.`;

const DEFAULT_PXT_JSON = JSON.stringify(
  {
    name: "Untitled",
    description: "",
    dependencies: { core: "*", radio: "*" },
    files: ["main.blocks", "main.ts", "README.md"],
    preferredEditor: "blocksprj",
  },
  null,
  2,
);
const DEFAULT_MAIN_BLOCKS =
  '<xml xmlns="http://www.w3.org/1999/xhtml"><variables></variables></xml>';
const DEFAULT_README = " ";

// Merge user files with MakeCode's minimal required set (pxt.json,
// main.blocks, README.md) and overwrite main.ts. Without these defaults,
// importProject is silently ignored when a freshly initialised editor's
// workspace-save returns an empty/partial file map.
export function fillProjectDefaults(
  text: Record<string, string>,
  code: string,
): Record<string, string> {
  return {
    "main.blocks": text["main.blocks"] ?? DEFAULT_MAIN_BLOCKS,
    "README.md": text["README.md"] ?? DEFAULT_README,
    "pxt.json": text["pxt.json"] ?? DEFAULT_PXT_JSON,
    ...text,
    "main.ts": code,
  };
}
