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

// How far back to look for console diagnostics when setProject fails. They fire
// during the decompile attempt, just before the in-page confirm timeout rejects,
// so a few seconds comfortably covers the gap without risking errors from an
// earlier program.
const DIAGNOSTICS_WINDOW_MS = 5_000;

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
    const result = (await this.page.evaluate(
      (text: unknown) =>
        (
          window as unknown as {
            __mkcp: { importProject(t: unknown): Promise<unknown> };
          }
        ).__mkcp.importProject(text),
      project.text,
    )) as ShimResult<void>;
    if (result.ok) return;
    throw this.compileError(result.error);
  }

  // The in-page adapter can only report a generic "failed to compile to blocks"
  // (it can't read the cross-origin editor console). On the Node side we can:
  // attach the real TS diagnostics captured from the page console so the model
  // gets line/column messages to fix. Only enrich genuine compile failures;
  // transport errors must not get stale diagnostics stapled on.
  private compileError(message: string): Error {
    if (/failed to compile to blocks/i.test(message)) {
      const diagnostics = this.page.recentDiagnostics?.(DIAGNOSTICS_WINDOW_MS) ?? [];
      if (diagnostics.length > 0) {
        return new Error(`${message}\n\nCompiler errors:\n${diagnostics.join("\n")}`);
      }
    }
    return new Error(message);
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
