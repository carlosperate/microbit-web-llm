export const EMPTY_EDITOR_ERROR =
  "No code loaded in the editor. Call set_code first to load code before requesting get_blocks_image.";

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

// Merge user-supplied files with the minimal set MakeCode needs (pxt.json,
// main.blocks, README.md) and overwrite main.ts with `code`. The workspace-save
// event on a freshly initialised editor can return an empty or partial file
// map; without these defaults importProject is silently ignored.
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
