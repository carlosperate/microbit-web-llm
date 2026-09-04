// Server-canonical session state. A session is *data here*, not a browser tab:
// the shared editor tab is a scratchpad that every op loads into, so nothing
// about a session's project survives in Chrome between calls.

export interface SessionRecord {
  readonly id: string;
  readonly label?: string;
  /** Project files exactly as MakeCode last emitted them (main.ts, main.blocks,
   *  pxt.json, …), never a server-side guess. */
  readonly files: Readonly<Record<string, string>>;
  /** 0 until the first commit, then bumped on each one. Lets a view detect
   *  that its copy is stale. */
  readonly version: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export type SessionChangeType = "created" | "committed" | "removed";

export interface SessionChange {
  type: SessionChangeType;
  sessionId: string;
  /** The new state; absent for `removed`. */
  record?: SessionRecord;
  /** Who caused it, when it wasn't a tool call: the id of the view whose user
   *  edit this was. Lets that view skip the echo of its own change. */
  source?: string;
}

export type SessionListener = (change: SessionChange) => void;

export interface SessionStoreOptions {
  /** Override the clock. Defaults to `Date.now`. Tests inject a fake. */
  now?: () => number;
}

export interface CreateSessionOptions {
  label?: string;
  /** Initial project, normally the empty MakeCode default. */
  files?: Record<string, string>;
}

interface Entry {
  id: string;
  label?: string;
  files: Record<string, string>;
  version: number;
  createdAt: number;
  lastUsedAt: number;
}

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<SessionListener>();
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  create(id: string, opts: CreateSessionOptions = {}): SessionRecord {
    const at = this.now();
    const entry: Entry = {
      id,
      files: { ...(opts.files ?? {}) },
      version: 0,
      createdAt: at,
      lastUsedAt: at,
    };
    if (opts.label !== undefined) entry.label = opts.label;
    this.entries.set(id, entry);
    const record = snapshot(entry);
    this.emit({ type: "created", sessionId: id, record });
    return record;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): SessionRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? snapshot(entry) : undefined;
  }

  /** Replace the project with what the editor just saved. `source` names the
   *  view a user edit came from; omit it for tool-driven writes. */
  commit(id: string, files: Record<string, string>, source?: string): SessionRecord {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`cannot commit unknown session ${id}`);
    entry.files = { ...files };
    entry.version += 1;
    entry.lastUsedAt = this.now();
    const record = snapshot(entry);
    this.emit({
      type: "committed",
      sessionId: id,
      record,
      ...(source !== undefined ? { source } : {}),
    });
    return record;
  }

  touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.lastUsedAt = this.now();
  }

  delete(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    this.emit({ type: "removed", sessionId: id });
    return true;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Ids untouched for longer than `idleMs`, oldest-first by insertion. */
  staleIds(idleMs: number): string[] {
    const cutoff = this.now() - idleMs;
    const stale: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) stale.push(id);
    }
    return stale;
  }

  /** Change feed for Phase 2 widget views. Returns an unsubscribe handle. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: SessionChange): void {
    for (const listener of this.listeners) {
      // One misbehaving view must not break the session or starve the others.
      try {
        listener(change);
      } catch {
        // ignored
      }
    }
  }
}

function snapshot(entry: Entry): SessionRecord {
  const record: SessionRecord = {
    id: entry.id,
    files: { ...entry.files },
    version: entry.version,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
  return entry.label !== undefined ? { ...record, label: entry.label } : record;
}
