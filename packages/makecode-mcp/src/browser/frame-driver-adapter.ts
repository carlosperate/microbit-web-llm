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
    const files: MakeCodeProjectFiles = { text: event.project.text ?? {} };
    this.latestHeader = event.project.header;
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
    try {
      await this.driver.switchBlocks();
    } catch {
      // switchBlocks can reject if decompile fails (invalid TS). Leave the
      // editor in whatever view importProject chose rather than propagating.
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
