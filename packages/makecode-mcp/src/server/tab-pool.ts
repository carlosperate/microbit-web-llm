import type { MakeCodeDriver } from "../browser/driver-port.js";

export interface TabPool {
  /**
   * Serialized access to the single persistent editor tab. Loading MakeCode is
   * slow (potentially minutes on a fresh cache + slow connection), so we pay
   * that cost once at server startup and reuse the tab for everything: the
   * `*_from_code` tools and every session op that needs the editor. The tab
   * holds no state between calls, so each `fn` must load whatever project it
   * needs; calls serialize on a per-pool mutex so they can't race on the
   * editor's single-project state.
   */
  withStatelessTab<T>(fn: (driver: MakeCodeDriver) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
