import type { MakeCodeDriver, MakeCodeProjectFiles } from "../browser/driver-port.js";
import type { PageLike } from "./browser-pool.js";

// Iframe RPC boundary. The shim methods (see src/shell/shim.ts) return
// a tagged union `Result<T>` rather than throwing across page.evaluate —
// Puppeteer's exception marshalling would otherwise append a browser-side
// stack frame to the error message and leak it to the MCP client. Translating
// here, after the boundary, keeps the model-facing message clean.
export type ShimResult<T> = { ok: true; value: T } | { ok: false; error: string };

function unwrap<T>(result: ShimResult<T>): T {
  if (result.ok) return result.value;
  throw new Error(result.error);
}

export class PuppeteerDriver implements MakeCodeDriver {
  constructor(private readonly page: PageLike) {}

  async getProject(): Promise<MakeCodeProjectFiles> {
    return unwrap(
      (await this.page.evaluate(
        `window.__mkcp.saveProject()`,
      )) as ShimResult<MakeCodeProjectFiles>,
    );
  }

  async setProject(project: MakeCodeProjectFiles): Promise<void> {
    unwrap(
      (await this.page.evaluate(
        (text: unknown) =>
          (
            window as unknown as {
              __mkcp: { importProject(t: unknown): Promise<unknown> };
            }
          ).__mkcp.importProject(text),
        project.text,
      )) as ShimResult<void>,
    );
  }

  async compile(): Promise<{ name: string; hex: string }> {
    return unwrap(
      (await this.page.evaluate(`window.__mkcp.compile()`)) as ShimResult<{
        name: string;
        hex: string;
      }>,
    );
  }

  async renderBlocksImage(code: string): Promise<string> {
    return unwrap(
      (await this.page.evaluate(
        (c: unknown) =>
          (
            window as unknown as {
              __mkcp: { renderBlocksImage(c: unknown): Promise<unknown> };
            }
          ).__mkcp.renderBlocksImage(c),
        code,
      )) as ShimResult<string>,
    );
  }
}
