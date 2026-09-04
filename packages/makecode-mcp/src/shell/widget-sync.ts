// Keeps one editor view in step with the server's copy of a session. Pure
// logic: the transport (SSE down, POST up) and the MakeCode adapter are
// injected, so this is the part that can be tested without a browser.

export type ViewMessage =
  | { type: "project"; version: number; files: Record<string, string> }
  | { type: "session-gone" };

export interface ProjectSyncOptions {
  /** Import a server-sent project into the live editor. Must wait for the
   *  editor to be ready, and must switch it to blocks so a project whose
   *  main.blocks is stale gets decompiled from main.ts rather than
   *  overwriting it. */
  apply(files: Record<string, string>): Promise<void>;
  /** Send a user edit up; resolves with the version the server assigned. */
  save(files: Record<string, string>, baseVersion: number): Promise<number>;
  /** Read what the editor actually holds, used to reconcile after an import. */
  readEditor?(): Promise<Record<string, string>>;
  onSessionGone?(): void;
  onError?(err: unknown): void;
}

export class ProjectSync {
  private serverFiles: string | null = null;
  private serverVersion = 0;
  private applying = false;
  private saving = false;
  /** Serialises remote applies: two imports must never share one editor. */
  private applyChain: Promise<void> = Promise.resolve();
  /** Newest project seen while an apply was running; older ones are dropped. */
  private pendingRemote: Record<string, string> | null = null;
  /** Newest edit seen while a save was in flight; older ones are dropped. */
  private queued: Record<string, string> | null = null;

  constructor(private readonly opts: ProjectSyncOptions) {}

  get version(): number {
    return this.serverVersion;
  }

  receive(message: ViewMessage): void {
    if (message.type === "session-gone") {
      this.opts.onSessionGone?.();
      return;
    }
    this.serverFiles = stable(message.files);
    this.serverVersion = message.version;
    // A burst (the empty project at attach, then session_set_code) coalesces to
    // the newest: applying a superseded version is pointless work on a shared
    // editor, and interleaving two imports corrupts it.
    this.pendingRemote = message.files;
    this.applyChain = this.applyChain
      .then(async () => {
        const files = this.pendingRemote;
        this.pendingRemote = null;
        if (files) await this.applyRemote(files);
      })
      // A rejected link would break the chain for good and every later project
      // would be dropped in silence, so it always settles.
      .catch((err: unknown) => this.opts.onError?.(err));
  }

  private async applyRemote(files: Record<string, string>): Promise<void> {
    this.applying = true;
    let applied = true;
    try {
      await this.opts.apply(files);
    } catch (err) {
      applied = false;
      this.opts.onError?.(err);
    } finally {
      this.applying = false;
    }
    // Reconciling a failed import would read back the *previous* project and
    // push it up, undoing the write the server just made. Stay quiet instead.
    if (!applied) return;
    // Saves are ignored while importing, and that window is exactly when
    // MakeCode emits the decompiled project. Read the editor back so the
    // server learns what it really ended up with (including an edit the user
    // slipped in mid-import) instead of assuming it took our copy verbatim.
    try {
      const actual = await this.opts.readEditor?.();
      if (!actual) return;
      // An import that left the editor with no code didn't work (a stale
      // main.blocks can make MakeCode regenerate main.ts as empty). Reporting
      // that would push the emptiness up and lose the session's code.
      if (hasCode(files) && !hasCode(actual)) {
        this.opts.onError?.(new Error("import left the editor empty; not reporting it"));
        return;
      }
      this.workspaceSaved(actual);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  workspaceSaved(files: Record<string, string>): void {
    // Before hydration the editor still holds its bootstrap project, and
    // mid-import it holds a half-built one. Neither is a user edit.
    if (this.serverFiles === null || this.applying) return;
    if (stable(files) === this.serverFiles) return;
    if (this.saving) {
      this.queued = files;
      return;
    }
    void this.push(files);
  }

  private async push(files: Record<string, string>): Promise<void> {
    this.saving = true;
    try {
      const version = await this.opts.save(files, this.serverVersion);
      this.serverFiles = stable(files);
      this.serverVersion = version;
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.saving = false;
    }
    const next = this.queued;
    this.queued = null;
    if (next && stable(next) !== this.serverFiles) await this.push(next);
  }
}

function hasCode(files: Record<string, string>): boolean {
  return (files["main.ts"] ?? "").trim().length > 0;
}

/** Key-order-independent comparison, so a re-serialised project that means the
 *  same thing doesn't read as an edit. */
function stable(files: Record<string, string>): string {
  const keys = Object.keys(files).sort();
  return JSON.stringify(keys.map((k) => [k, files[k]]));
}
