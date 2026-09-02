import { randomUUID } from "node:crypto";
import type {
  BlocksImage,
  ServerExecutor,
  StartSessionOptions,
  StartSessionResult,
} from "../shared/types.js";
import { SessionError } from "../shared/types.js";
import { TOOL } from "../shared/tools.js";
import { renderCurrentBlocks, writeCode, projectForCode } from "../shared/executor-ops.js";
import {
  EMPTY_EDITOR_ERROR,
  fillProjectDefaults,
} from "../shared/project-defaults.js";
import { createLogger } from "../shared/logger.js";
import type { MakeCodeDriver } from "../browser/driver-port.js";
import { SessionStore, type SessionRecord } from "./session-store.js";
import type { TabPool } from "./tab-pool.js";

const log = createLogger("session-executor");
const SESSION_GONE_MSG = `session_id is no longer available. The session timed out after a period of inactivity. Call ${TOOL.SESSION_START} to get a new one.`;
const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The shared adapter's compile errors (pre-validation rejection or decompile
 *  hint) say to call session_set_code, but on the stateless path there is no
 *  session; retry the calling tool instead. */
function retargetCompileHint(err: unknown, toolName: string): unknown {
  if (err instanceof Error && err.message.includes(TOOL.SESSION_SET_CODE)) {
    return new Error(err.message.replaceAll(TOOL.SESSION_SET_CODE, toolName));
  }
  return err;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;
/** Bound the expired-id history; once full, the oldest entries fall out and
 *  subsequent use of those ids returns "unknown" instead of "expired". */
const MAX_EXPIRED_HISTORY = 256;

export interface SessionExecutorOptions {
  /**
   * Sessions whose last touch is older than this are dropped by the background
   * reaper. Subsequent use of a reaped session returns `SessionError("expired")`.
   * Default: 30 minutes. Set to `0` (or negative) to disable.
   */
  idleTimeoutMs?: number;
  /**
   * How often the background reaper checks for stale sessions. Default: 1 min.
   * Set to `0` to disable the timer entirely (tests drive `reapIdleSessions()`
   * manually).
   */
  reapIntervalMs?: number;
  /** Override the clock. Defaults to `Date.now`. Tests inject a fake. */
  now?: () => number;
}

/**
 * Sessions are server-side data, not browser tabs. Every op that genuinely
 * needs MakeCode (write, hex, render) borrows the pool's single shared editor
 * tab and loads the session's own project into it first, so a session survives
 * anything that happens to Chrome and costs nothing while idle.
 */
export class SessionExecutor implements ServerExecutor {
  /** Canonical session state. Phase 2 subscribes widget views here. */
  readonly store: SessionStore;
  /** Insertion-ordered set of recently reaped session ids so we can return
   *  `expired` instead of `unknown` for a bounded window after a reap. */
  private readonly expiredIds = new Set<string>();
  /** Tail of each session's op queue; see `withSession`. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: TabPool,
    opts: SessionExecutorOptions = {},
  ) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.store = new SessionStore({ now: this.now });
    const reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    if (this.idleTimeoutMs > 0 && reapIntervalMs > 0) {
      this.reapTimer = setInterval(() => this.reapIdleSessions(), reapIntervalMs);
      // Don't keep the Node process alive solely for this timer.
      this.reapTimer.unref?.();
    }
  }

  async startSession(opts?: StartSessionOptions): Promise<StartSessionResult> {
    const session_id = randomUUID();
    // Seed the empty MakeCode default project so the session is importable
    // (and compilable) before the first write.
    this.store.create(session_id, {
      files: fillProjectDefaults({}, ""),
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    });
    log.info("startSession", {
      session_id,
      label: opts?.label,
      openSessions: this.store.size,
    });
    return { session_id };
  }

  async endSession(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
    this.store.delete(sessionId);
    log.info("endSession", { session_id: sessionId, openSessions: this.store.size });
  }

  /**
   * Drop any session whose last use is older than `idleTimeoutMs`. Exposed so
   * tests can drive the reaper deterministically; in production the background
   * interval calls it.
   */
  reapIdleSessions(): void {
    if (this.idleTimeoutMs <= 0) return;
    for (const id of this.store.staleIds(this.idleTimeoutMs)) {
      this.store.delete(id);
      this.markExpired(id);
      log.info("reapIdleSessions → dropped idle session", { session_id: id });
    }
  }

  private markExpired(sessionId: string): void {
    this.expiredIds.add(sessionId);
    while (this.expiredIds.size > MAX_EXPIRED_HISTORY) {
      const oldest = this.expiredIds.values().next().value;
      if (oldest === undefined) break;
      this.expiredIds.delete(oldest);
    }
  }

  async getCurrentCode(sessionId: string): Promise<string> {
    return this.withSession(sessionId, async (rec) => rec.files["main.ts"] ?? "");
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    await this.withSession(sessionId, async (rec) => {
      const files = await this.pool.withStatelessTab(async (d) => {
        // setProject pre-validates the TS and confirms the decompile, so bad
        // code throws here and the stored project stays as it was.
        await d.setProject(projectForCode(rec.files, code));
        return (await d.getProject()).text;
      });
      // Persist what MakeCode itself saved (main.blocks included), never our
      // input. A session ended mid-write has nothing left to commit to.
      if (this.store.has(sessionId)) this.store.commit(sessionId, files);
    });
  }

  async getBlocksImage(sessionId: string): Promise<BlocksImage> {
    return this.withSession(sessionId, async (rec) => {
      const code = rec.files["main.ts"] ?? "";
      if (code.trim().length === 0) throw new Error(EMPTY_EDITOR_ERROR);
      // renderBlocksImage is standalone (it takes TS), so reads never import
      // and so can't fail a decompile.
      const pngBase64 = await this.pool.withStatelessTab((d) =>
        d.renderBlocksImage(code),
      );
      return { pngBase64 };
    });
  }

  async getHexFile(sessionId: string): Promise<string> {
    return this.withSession(sessionId, async (rec) =>
      this.pool.withStatelessTab(async (d) => {
        // compile() works off the editor's loaded project, so load ours first.
        await d.setProject({ text: { ...rec.files } });
        const { hex } = await d.compile();
        return toBase64(hex);
      }),
    );
  }

  /**
   * Run `fn` against the session's current record, serialised per session so a
   * slow write can't be interleaved with a read that would then render or
   * compile a half-written project. The session is re-resolved after the wait
   * because it may have been ended or reaped while queued.
   */
  private async withSession<T>(
    sessionId: string,
    fn: (rec: SessionRecord) => Promise<T>,
  ): Promise<T> {
    this.requireSession(sessionId);
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(sessionId, gate);
    try {
      await previous.catch(() => {});
      return await fn(this.requireSession(sessionId));
    } finally {
      release();
      if (this.locks.get(sessionId) === gate) this.locks.delete(sessionId);
    }
  }

  async getBlocksImageFromCode(code: string): Promise<BlocksImage> {
    return this.pool.withStatelessTab(async (d) => {
      // Same setProject path session_set_code uses, so the editor's
      // pre-validation and decompile-confirm reject TS that doesn't compile.
      await this.writeStateless(d, code, TOOL.GET_BLOCKS_IMG_FROM_CODE);
      // Render the editor's read-back main.ts, so valid-but-undecompilable
      // code falls out as the grey raw-text block just like the session path.
      return renderCurrentBlocks(d);
    });
  }

  async getHexFileFromCode(code: string): Promise<string> {
    return this.pool.withStatelessTab(async (d) => {
      await this.writeStateless(d, code, TOOL.GET_HEX_FILE_FROM_CODE);
      const { hex } = await d.compile();
      return toBase64(hex);
    });
  }

  /** Load code into the shared tab for a session-less tool, retargeting the
   *  compile hint at the caller. */
  private async writeStateless(
    driver: MakeCodeDriver,
    code: string,
    toolName: string,
  ): Promise<void> {
    try {
      await writeCode(driver, code);
    } catch (err) {
      throw retargetCompileHint(err, toolName);
    }
  }

  async dispose(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    const ids = this.store.ids();
    log.info("dispose → dropping sessions and pool", { openSessions: ids.length });
    for (const id of ids) this.store.delete(id);
    await this.pool.dispose();
  }

  private requireSession(sessionId: string): SessionRecord {
    if (!sessionId) {
      throw new SessionError(
        "missing",
        `session_id is required. Call ${TOOL.SESSION_START} first.`,
      );
    }
    if (this.expiredIds.has(sessionId)) {
      throw new SessionError("expired", SESSION_GONE_MSG);
    }
    const record = this.store.get(sessionId);
    if (!record) {
      throw new SessionError(
        "unknown",
        `session_id is unknown. Call ${TOOL.SESSION_START} to get a new one.`,
      );
    }
    this.store.touch(sessionId);
    return record;
  }
}
