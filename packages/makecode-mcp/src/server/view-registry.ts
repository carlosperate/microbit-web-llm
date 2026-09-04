import { createLogger } from "../shared/logger.js";

const log = createLogger("view-registry");

/** What the server pushes down to an attached editor view. */
export type ViewMessage =
  | { type: "project"; version: number; files: Record<string, string> }
  | { type: "session-gone" };

/** One attached editor (today: a widget bridge iframe). Views are pure
 *  observers: tool calls read and write `SessionStore` whether or not any
 *  view exists. */
export interface SessionView {
  readonly id: string;
  readonly sessionId: string;
  send(message: ViewMessage): void;
  close(): void;
}

export interface BroadcastOptions {
  /** View id to skip, so a user edit isn't echoed back at its author. */
  except?: string;
}

export class ViewRegistry {
  private readonly bySession = new Map<string, Set<SessionView>>();

  /** Returns the detach handle. Detaching is identity-based, so a stale
   *  handle can't evict a reconnected view that reused the same id. */
  attach(view: SessionView): () => void {
    let views = this.bySession.get(view.sessionId);
    if (!views) {
      views = new Set();
      this.bySession.set(view.sessionId, views);
    }
    views.add(view);
    log.info("view attached", {
      session_id: view.sessionId,
      view: view.id,
      views: views.size,
    });
    return () => this.detach(view);
  }

  private detach(view: SessionView): void {
    const views = this.bySession.get(view.sessionId);
    if (!views?.delete(view)) return;
    if (views.size === 0) this.bySession.delete(view.sessionId);
    log.info("view detached", { session_id: view.sessionId, view: view.id });
  }

  broadcast(sessionId: string, message: ViewMessage, opts: BroadcastOptions = {}): void {
    const views = this.bySession.get(sessionId);
    if (!views) return;
    for (const view of views) {
      if (view.id === opts.except) continue;
      // A broken transport must not stop delivery to the other views.
      try {
        view.send(message);
      } catch (err) {
        log.warn("view send failed", { view: view.id, error: String(err) });
      }
    }
  }

  countFor(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  closeAll(sessionId: string): void {
    const views = this.bySession.get(sessionId);
    if (!views) return;
    this.bySession.delete(sessionId);
    for (const view of views) closeQuietly(view);
  }

  closeEverything(): void {
    const all = [...this.bySession.values()].flatMap((v) => [...v]);
    this.bySession.clear();
    for (const view of all) closeQuietly(view);
  }
}

function closeQuietly(view: SessionView): void {
  try {
    view.close();
  } catch {
    // Already gone; nothing to do.
  }
}
