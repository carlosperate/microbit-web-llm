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
  /**
   * Serialized access to a shared persistent "stateless" editor tab used by
   * the `*_from_code` tools. Loading MakeCode is slow (potentially minutes on
   * a fresh cache + slow connection), so we pay that cost once at server
   * startup and reuse the tab for every stateless call. Calls serialize on a
   * per-pool mutex so the editor's single-project state can't race.
   */
  withStatelessTab<T>(fn: (driver: MakeCodeDriver) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
