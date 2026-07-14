import { createMakeCodeRenderBlocks } from "@microbit/makecode-embed/vanilla";
import type { MakeCodeDriver, MakeCodeProjectFiles } from "./driver-port.js";
import { compileRejectedError } from "../shared/compile-errors.js";
import { svgToPngBase64 } from "../shared/svg-to-png.js";
import { TOOL } from "../shared/tools.js";
import { localCompiler } from "./local-compiler.js";

interface WorkspaceSaveEventLike {
  project: {
    header?: unknown;
    text?: Record<string, string>;
  };
}

interface DownloadEvent {
  name: string;
  hex: string;
}

// Cap compile() so a wedged MakeCode editor can't pin the tool loop forever.
// Real compiles on slow networks finish well under a minute; 2 min gives
// plenty of headroom while still being short enough to surface as a recoverable
// error to the model before the user gives up.
const COMPILE_TIMEOUT_MS = 120_000;

// After switchBlocks resolves on a healthy import, MakeCode keeps the
// workspacesave flow going (it emits at least one more save once decompile
// completes). When decompile silently fails — `switchblocks` still replies
// `success:true` but the editor falls back to JS view behind a modal — no
// further workspacesave events arrive at all. Time-boxing the wait turns that
// silence into a recoverable error the model can act on. Observed good-case
// latency is ~270 ms (in-iframe CPU only — no network); 1.5 s leaves ~5×
// headroom while keeping the failure path snappy for the LLM tool loop.
const DECOMPILE_CONFIRM_TIMEOUT_MS = 1_500;

// MakeCode rejects switchBlocks with editor-side diagnostic strings when the
// TypeScript can't be decompiled to blocks. Transient failures (transport
// hiccups, generic "not successful" replies) come back with very different
// messages — rewrapping those as "Fix the TypeScript" is actively misleading,
// so we only attach the self-correction hint when the message actually looks
// like a decompile failure.
function looksLikeDecompileFailure(message: string): boolean {
  return (
    /cannot convert to blocks/i.test(message) ||
    /decompile/i.test(message) ||
    /unsupported syntax/i.test(message) ||
    /ts\d{4}\b/i.test(message)
  );
}

interface FrameDriverLike {
  saveProject(): Promise<void>;
  importProject(options: {
    project: { header?: unknown; text?: Record<string, string> };
  }): Promise<void>;
  compile(): Promise<void>;
  switchBlocks(): Promise<void>;
}

type LocalDiagnostics = (
  code: string,
  dependencies?: Record<string, string>,
) => Promise<string[]>;

function dependenciesOf(pxtJson: string | undefined): Record<string, string> | undefined {
  if (!pxtJson) return undefined;
  try {
    const deps = (JSON.parse(pxtJson) as { dependencies?: unknown }).dependencies;
    return deps && typeof deps === "object" ? (deps as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

export class MakeCodeFrameDriverAdapter implements MakeCodeDriver {
  private latestHeader: unknown;
  private pendingSaveCallbacks: Array<(p: MakeCodeProjectFiles) => void> = [];
  private pendingDownload: ((d: DownloadEvent) => void) | null = null;
  private compileInFlight = false;
  private renderer: ReturnType<typeof createMakeCodeRenderBlocks> | null = null;

  constructor(
    private readonly driver: FrameDriverLike,
    private readonly localDiagnostics: LocalDiagnostics = (code, deps) =>
      localCompiler.getDiagnostics(code, deps),
  ) {}

  private getRenderer() {
    if (!this.renderer) {
      this.renderer = createMakeCodeRenderBlocks({});
      this.renderer.initialize();
    }
    return this.renderer;
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }

  handleWorkspaceSave(event: WorkspaceSaveEventLike): void {
    if (event.project.header !== undefined) this.latestHeader = event.project.header;
    // MakeCode emits workspacesave with only a header (no text) after internal
    // triggers like importProject. Don't drain saveProject() waiters with
    // those — they'd resolve {} and downstream reads see an empty main.ts.
    const text = event.project.text;
    if (!text) return;
    const files: MakeCodeProjectFiles = { text };
    const callbacks = this.pendingSaveCallbacks.splice(0);
    for (const cb of callbacks) cb(files);
  }

  handleDownload(event: DownloadEvent): void {
    const cb = this.pendingDownload;
    this.pendingDownload = null;
    cb?.(event);
  }

  async getProject(): Promise<MakeCodeProjectFiles> {
    const waiter = new Promise<MakeCodeProjectFiles>((res) => {
      this.pendingSaveCallbacks.push(res);
    });
    // Only one saveProject call needed regardless of how many callers are waiting.
    if (this.pendingSaveCallbacks.length === 1) {
      await this.driver.saveProject();
    }
    return waiter;
  }

  async setProject(project: MakeCodeProjectFiles): Promise<void> {
    // Reject uncompilable code before it reaches the editor: switching it to
    // blocks would pop MakeCode's blocking convert-failure modal, which can't
    // be dismissed cross-origin. Fail-open: no compiler → load-and-see.
    const code = project.text["main.ts"] ?? "";
    const emptyProgram = code.trim().length === 0;
    if (!emptyProgram) {
      const errors = await this.localDiagnostics(
        code,
        dependenciesOf(project.text["pxt.json"]),
      ).catch(() => [] as string[]);
      if (errors.length > 0) {
        throw new Error(compileRejectedError(TOOL.SESSION_SET_CODE, errors));
      }
    }
    await this.driver.importProject({
      project: {
        ...(this.latestHeader ? { header: this.latestHeader } : {}),
        text: project.text,
      },
    });
    // Importing with empty main.blocks lands the editor in JS view; force
    // blocks view so MakeCode decompiles main.ts. If decompile fails (invalid
    // TS), switchBlocks rejects — surface that so the model self-corrects
    // instead of calling session_get_blocks_img on uncompilable code.
    try {
      await this.driver.switchBlocks();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!looksLikeDecompileFailure(reason)) throw err;
      throw new Error(
        `Code was loaded into the editor but failed to compile to blocks: ${reason}. Fix the TypeScript and call ${TOOL.SESSION_SET_CODE} again.`,
      );
    }
    // switchBlocks resolves with `success:true` even when MakeCode silently
    // falls back to JS view because the TS can't be decompiled (it shows an
    // in-iframe modal instead). Wait for the next post-switch workspacesave —
    // on a healthy decompile, MakeCode keeps the save flow going; on failure,
    // no further saves arrive at all. Empty programs never trigger a follow-up
    // save and we don't want to false-positive on the initial blank import.
    if (emptyProgram) return;
    const decompileConfirmed = await this.awaitNextSaveOrTimeout(
      DECOMPILE_CONFIRM_TIMEOUT_MS,
    );
    if (!decompileConfirmed) {
      throw new Error(
        `Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call ${TOOL.SESSION_SET_CODE} again.`,
      );
    }
  }

  // One-shot waiter for the next text-bearing workspacesave. Used by setProject
  // to detect silent decompile failure: a real switch emits a follow-up save;
  // a failed one emits nothing.
  private awaitNextSaveOrTimeout(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const onSave = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      this.pendingSaveCallbacks.push(onSave);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.pendingSaveCallbacks.indexOf(onSave);
        if (idx >= 0) this.pendingSaveCallbacks.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
    });
  }

  async compile(): Promise<DownloadEvent> {
    if (this.compileInFlight) {
      throw new Error(
        "A compile is already in progress. Wait for it to complete before calling compile again.",
      );
    }
    this.compileInFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const waiter = new Promise<DownloadEvent>((resolve, reject) => {
        this.pendingDownload = (d) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(d);
        };
        timer = setTimeout(() => {
          this.pendingDownload = null;
          reject(
            new Error(
              `Compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s — try again or simplify the program.`,
            ),
          );
        }, COMPILE_TIMEOUT_MS);
      });
      await this.driver.compile();
      return await waiter;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.compileInFlight = false;
      this.pendingDownload = null;
    }
  }

  async renderBlocksImage(code: string, scale?: number): Promise<string> {
    const result = await this.getRenderer().renderBlocks({ code });
    const svg = result.svg;
    // makecode-embed returns `resp: undefined` when the standalone renderer
    // can't compile the TS to blocks. Silently coercing to an empty PNG hid
    // the failure from the model — surface it as a tool error so the LLM can
    // fix the code instead of staring at a 0-byte image.
    if (!svg) {
      throw new Error(
        "The code could not be compiled into blocks, fix any errors and try again.",
      );
    }
    return scale === undefined ? svgToPngBase64(svg) : svgToPngBase64(svg, scale);
  }
}
