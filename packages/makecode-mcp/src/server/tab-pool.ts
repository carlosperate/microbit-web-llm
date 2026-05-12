import type { MakeCodeDriver } from "../browser/driver-port.js";

export interface TabHandle {
  driver: MakeCodeDriver;
  close(): Promise<void>;
}

export interface OpenTabOptions {
  /** Session id assigned by the caller; embedded in the shell URL. */
  sessionId?: string;
  /** Optional human label embedded in the shell URL for the window title. */
  label?: string;
}

export interface TabPool {
  openTab(opts?: OpenTabOptions): Promise<TabHandle>;
  withTransientTab<T>(fn: (driver: MakeCodeDriver) => Promise<T>): Promise<T>;
  /**
   * Render-only path for stateless block image rendering. Backed by a
   * persistent tab that loads only `createMakeCodeRenderBlocks` — no editor
   * iframe — so calls are near-instant and don't pay the makecode.microbit.org
   * load cost on every invocation.
   */
  renderBlocksImage(code: string): Promise<string>;
  dispose(): Promise<void>;
}
