import type { MakeCodeDriver } from "../browser/driver-port.js";
import type { BlocksImage } from "./types.js";
import { EMPTY_EDITOR_ERROR, fillProjectDefaults } from "./project-defaults.js";

// Shared core operations against a MakeCodeDriver. Both executors (browser
// IframeExecutor, server TabExecutor) wrap these to add their own concerns —
// logging on the browser, session lookup on the server — but the core
// editor-state semantics live here so the "drop main.blocks before re-import"
// invariant and the empty-editor guard exist in exactly one place.

export async function readCurrentCode(driver: MakeCodeDriver): Promise<string> {
  const project = await driver.getProject();
  return project.text["main.ts"] ?? "";
}

export async function writeCode(driver: MakeCodeDriver, code: string): Promise<void> {
  const current = await driver.getProject();
  // Drop main.blocks so the blocks view re-decompiles from the new main.ts.
  // Keeping the previous main.blocks would cause the blocks editor to render
  // stale blocks and ignore the TS update — and on first import would even
  // overwrite main.ts with the decompiled (empty) result.
  const { "main.blocks": _drop, ...rest } = current.text;
  await driver.setProject({
    text: { ...fillProjectDefaults(rest, code), "main.blocks": "" },
  });
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
