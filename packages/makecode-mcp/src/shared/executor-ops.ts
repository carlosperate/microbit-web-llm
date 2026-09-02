import type { MakeCodeDriver, MakeCodeProjectFiles } from "../browser/driver-port.js";
import type { BlocksImage } from "./types.js";
import { EMPTY_EDITOR_ERROR, fillProjectDefaults } from "./project-defaults.js";

// Shared core ops against a MakeCodeDriver. Both executors wrap these to add
// their own concerns (browser logging, server session lookup); the
// editor-state invariants (drop main.blocks before re-import, empty-editor
// guard) live here in one place.

export async function readCurrentCode(driver: MakeCodeDriver): Promise<string> {
  const project = await driver.getProject();
  return project.text["main.ts"] ?? "";
}

// The project to import for `code`, seeded from `base`: the editor's own files
// on the browser path, the session's stored files on the server. main.blocks is
// cleared so the blocks view re-decompiles from the new main.ts; keeping it
// renders stale blocks, and on first import overwrites main.ts with the
// decompiled (empty) result.
export function projectForCode(
  base: Readonly<Record<string, string>>,
  code: string,
): MakeCodeProjectFiles {
  const { "main.blocks": _drop, ...rest } = base;
  return { text: { ...fillProjectDefaults(rest, code), "main.blocks": "" } };
}

export async function writeCode(driver: MakeCodeDriver, code: string): Promise<void> {
  const current = await driver.getProject();
  await driver.setProject(projectForCode(current.text, code));
}

export async function renderCurrentBlocks(
  driver: MakeCodeDriver,
): Promise<BlocksImage> {
  const project = await driver.getProject();
  const code = project.text["main.ts"] ?? "";
  if (code.trim().length === 0) throw new Error(EMPTY_EDITOR_ERROR);
  const pngBase64 = await driver.renderBlocksImage(code);
  return { pngBase64 };
}
