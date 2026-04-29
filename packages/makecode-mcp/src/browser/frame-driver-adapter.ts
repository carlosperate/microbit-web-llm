import { createMakeCodeRenderBlocks } from "@microbit/makecode-embed/vanilla";
import type { MakeCodeDriver, MakeCodeProjectFiles } from "./driver-port.js";
import { svgToPngBase64 } from "../shared/svg-to-png.js";

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

interface FrameDriverLike {
  saveProject(): Promise<void>;
  importProject(options: {
    project: { header?: unknown; text?: Record<string, string> };
  }): Promise<void>;
  compile(): Promise<void>;
  switchBlocks(): Promise<void>;
}

export class MakeCodeFrameDriverAdapter implements MakeCodeDriver {
  private latestHeader: unknown;
  private latestFiles: MakeCodeProjectFiles | undefined;
  private pendingSaveCallbacks: Array<(p: MakeCodeProjectFiles) => void> = [];
  private pendingDownload: ((d: DownloadEvent) => void) | null = null;
  private compileInFlight = false;
  private renderer: ReturnType<typeof createMakeCodeRenderBlocks> | null = null;

  constructor(private readonly driver: FrameDriverLike) {}

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
    // MakeCode emits workspacesave events with only a header (no text) after
    // internal triggers like importProject. Those must not drain waiters
    // queued for an explicit saveProject() call, or the waiter resolves with
    // {} and downstream reads see an empty main.ts.
    const text = event.project.text;
    if (!text) return;
    // Merge incoming text fields into the cache rather than replacing it.
    // MakeCode fires workspacesave events with partial text (e.g. only
    // main.blocks after a view switch following importProject). Replacing
    // wholesale would drop the main.ts we just imported and make the next
    // get_blocks_image throw EMPTY_EDITOR_ERROR even though the editor still
    // shows the code.
    const merged: Record<string, string> = {
      ...(this.latestFiles?.text ?? {}),
      ...text,
    };
    const files: MakeCodeProjectFiles = { text: merged };
    this.latestFiles = files;
    const callbacks = this.pendingSaveCallbacks.splice(0);
    for (const cb of callbacks) cb(files);
  }

  handleDownload(event: DownloadEvent): void {
    const cb = this.pendingDownload;
    this.pendingDownload = null;
    cb?.(event);
  }

  async getProject(): Promise<MakeCodeProjectFiles> {
    if (this.latestFiles) return this.latestFiles;
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
    // Optimistic cache update so a getProject() immediately after returns the new state.
    this.latestFiles = project;
    await this.driver.importProject({
      project: {
        ...(this.latestHeader ? { header: this.latestHeader } : {}),
        text: project.text,
      },
    });
    // Importing with an empty main.blocks lands the editor in JS view. Force
    // blocks view so MakeCode decompiles main.ts into blocks for display.
    // If the decompile fails (invalid TS), MakeCode shows its own error popup
    // and rejects switchBlocks. Surface that rejection as a setProject error
    // so the LLM sees a tool error and self-corrects rather than blindly
    // calling get_blocks_image on uncompilable code.
    try {
      await this.driver.switchBlocks();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Code was loaded into the editor but failed to compile to blocks: ${reason}. Fix the TypeScript and call set_code again.`,
      );
    }
  }

  async compile(): Promise<DownloadEvent> {
    if (this.compileInFlight) {
      throw new Error(
        "A compile is already in progress. Wait for it to complete before calling compile again.",
      );
    }
    this.compileInFlight = true;
    try {
      const waiter = new Promise<DownloadEvent>((res) => {
        this.pendingDownload = res;
      });
      await this.driver.compile();
      return await waiter;
    } finally {
      this.compileInFlight = false;
      this.pendingDownload = null;
    }
  }

  async renderBlocksImage(code: string): Promise<string> {
    const result = await this.getRenderer().renderBlocks({ code });
    const svg = result.svg ?? "";
    if (!svg) return "";
    return svgToPngBase64(svg);
  }
}
